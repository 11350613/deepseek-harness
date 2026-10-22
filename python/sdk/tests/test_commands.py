"""Explicit command transport, results, and ordinary prompt compatibility."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

from deepseek_harness import CommandErrorResult, CommandExecution, CommandSuccessResult, DeepSeekHarness
from deepseek_harness.errors import JsonRpcError


@pytest.fixture
def peer(tmp_path: Path) -> Path:
    script = tmp_path / "commands.py"
    script.write_text('''import json
import os
import sys

def send(frame):
    print(json.dumps({"jsonrpc": "2.0", **frame}), flush=True)

for line in sys.stdin:
    frame = json.loads(line)
    with open(os.environ["REQUEST_LOG"], "a", encoding="utf-8") as log:
        log.write(line)
    method = frame["method"]
    params = frame.get("params") or {}
    if method == "initialize":
        send({"id": frame["id"], "result": {"serverInfo": {"name": "command-peer"}}})
    elif method == "session/command":
        for event_type in ("command/run", "command/done"):
            send({"method": "session.event", "params": {"sessionId": params["sessionId"],
                "event": {"type": event_type, "data": {"commandId": "command-1"}}}})
        send({"id": frame["id"], **json.loads(os.environ["COMMAND_RESPONSE"])})
    elif method == "session/prompt":
        session = params["sessionId"]
        send({"id": frame["id"], "result": {"messageId": "input-1"}})
        events = [
            {"type": "agent/inbox/spliced", "data": {"inserted": [{"id": "input-1"}]}},
            {"type": "assistant/message", "data": {"message": {"content": [{"type": "text", "text": "ordinary prompt"}]}}},
            {"type": "turn/end", "data": {"turn": 1, "reason": {"kind": "completed"}}},
        ]
        for event in events:
            send({"method": "session.event", "params": {"sessionId": session, "event": event}})
        send({"method": "session.status", "params": {"sessionId": session, "status": "idle"}})
    elif method == "shutdown":
        send({"id": frame["id"], "result": {}})
        break
    else:
        raise AssertionError(method)
''', encoding="utf-8")
    return script


def harness(peer: Path, tmp_path: Path, response: dict) -> DeepSeekHarness:
    return DeepSeekHarness(
        cwd=str(tmp_path),
        dsh_home=str(tmp_path / "home"),
        request_timeout_seconds=5,
        _launch_args=(sys.executable, str(peer)),
        env={"REQUEST_LOG": str(tmp_path / "requests.jsonl"), "COMMAND_RESPONSE": json.dumps(response)},
    )


def frames(tmp_path: Path) -> list[dict]:
    return [json.loads(line) for line in (tmp_path / "requests.jsonl").read_text(encoding="utf-8").splitlines()]


@pytest.mark.parametrize("result", [
    {"kind": "success"},
    {"kind": "success", "text": "Compacted.", "sourceEventSeq": 0},
    {"kind": "success", "sourceEventSeq": 2**53 - 1},
    {"kind": "error", "text": "The agent is busy."},
    {"kind": "error", "text": "  The agent is busy.\n"},
])
def test_command_returns_without_turn_or_idle_and_preserves_events(peer: Path, tmp_path: Path, result: dict) -> None:
    response = {"commandId": "command-1", "result": result}
    with harness(peer, tmp_path, {"result": response}) as sdk:
        session = sdk.start_session("main")
        with sdk.client.subscribe_session_notifications(session.id) as subscription:
            execution = sdk.client.session_command(session.id, "/compact")
            notifications = []
            subscription.drain(notifications.append)
        assert isinstance(execution, CommandExecution)
        assert execution.command_id == "command-1"
        assert isinstance(execution.result, CommandSuccessResult if result["kind"] == "success" else CommandErrorResult)
        assert execution.model_dump(by_alias=True, exclude_none=True) == response
        assert [item.payload["event"]["type"] for item in notifications] == ["command/run", "command/done"]
    sent = frames(tmp_path)
    assert [frame["method"] for frame in sent] == ["initialize", "session/command", "shutdown"]
    assert sent[1]["params"] == {"sessionId": "main", "line": "/compact"}


def test_low_level_command_preserves_the_line(peer: Path, tmp_path: Path) -> None:
    with harness(peer, tmp_path, {"result": {"commandId": "command-1", "result": {"kind": "success"}}}) as sdk:
        assert sdk.client.session_command("other", "/compact  \t").result.kind == "success"
    assert frames(tmp_path)[1]["params"] == {"sessionId": "other", "line": "/compact  \t"}


def test_command_rpc_rejection_does_not_fall_back_to_prompt(peer: Path, tmp_path: Path) -> None:
    with harness(peer, tmp_path, {"error": {"code": -32602, "message": "unsupported command"}}) as sdk:
        with pytest.raises(JsonRpcError, match="unsupported command") as raised:
            sdk.client.session_command("main", "/plan")
        assert raised.value.code == -32602
    assert [frame["method"] for frame in frames(tmp_path)] == ["initialize", "session/command", "shutdown"]


@pytest.mark.parametrize("response", [
    {},
    {"commandId": "command-1"},
    {"commandId": "", "result": {"kind": "success"}},
    {"commandId": "command-1", "result": {"kind": "unknown"}},
    {"commandId": "command-1", "result": {"kind": "error"}},
    {"commandId": "command-1", "result": {"kind": "error", "text": ""}},
    {"commandId": "command-1", "result": {"kind": "error", "text": " \t\n"}},
    {"commandId": "command-1", "result": {"kind": "success", "text": None}},
    {"commandId": "command-1", "result": {"kind": "success", "sourceEventSeq": None}},
    {"commandId": "command-1", "result": {"kind": "success", "sourceEventSeq": "4"}},
    {"commandId": "command-1", "result": {"kind": "success", "sourceEventSeq": True}},
    {"commandId": "command-1", "result": {"kind": "success", "sourceEventSeq": -1}},
    {"commandId": "command-1", "result": {"kind": "success", "sourceEventSeq": 2**53}},
])
def test_command_rejects_malformed_results(peer: Path, tmp_path: Path, response: dict) -> None:
    with harness(peer, tmp_path, {"result": response}) as sdk:
        with pytest.raises(ValidationError):
            sdk.client.session_command("main", "/compact")


def test_run_keeps_slash_text_as_an_ordinary_prompt(peer: Path, tmp_path: Path) -> None:
    with harness(peer, tmp_path, {"result": {}}) as sdk:
        result = sdk.start_session("main").run("/compact")
        assert result.final_response == "ordinary prompt"
        assert result.finish_reason == "completed"
    sent = frames(tmp_path)
    assert [frame["method"] for frame in sent] == ["initialize", "session/prompt", "shutdown"]
    assert sent[1]["params"] == {"sessionId": "main", "contentBlocks": [{"type": "text", "text": "/compact"}]}
