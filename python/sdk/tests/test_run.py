"""Unified blocking input, native command results and independent run observation."""
from __future__ import annotations

import json
import sys
import threading
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import pytest
from pydantic import BaseModel, ValidationError

from deepseek_harness import CommandExecution, DeepSeekHarness, Notification, RunResult, SdkProtocolError
from deepseek_harness.errors import JsonRpcError


class Ack(BaseModel):
    pass


@pytest.fixture
def peer(tmp_path: Path) -> Path:
    script = tmp_path / "queries.py"
    script.write_text('''import json
import os
import sys

serial = 0
pending_commands = []
pending_prompts = []

def send(frame):
    print(json.dumps({"jsonrpc": "2.0", **frame}), flush=True)

def event(session, type, data):
    send({"method": "session.event", "params": {"sessionId": session, "event": {"type": type, "data": data}}})

def input_text(frame):
    return "".join(block["text"] for block in frame["params"]["contentBlocks"] if block["type"] == "text")

def command(frame, number):
    session = frame["params"]["sessionId"]
    identity = "command-" + str(number)
    event(session, "command/run", {"commandId": identity})
    event(session, "command/done", {"commandId": identity, "kind": "success"})
    send({"id": frame["id"], "result": {"kind": "command", "execution": {
        "commandId": identity, "result": {"kind": "success", "text": "command completed"}}}})

def receipt(frame, number):
    session = frame["params"]["sessionId"]
    send({"method": "session.status", "params": {"sessionId": session, "status": "idle"}})
    event(session, "agent/inbox/spliced", {"inserted": [{"id": "input-" + str(number)}]})

def finish(frame):
    session = frame["params"]["sessionId"]
    event(session, "assistant/message", {"message": {"content": [
        {"type": "text", "text": "answer for " + input_text(frame)}]}})
    event(session, "turn/end", {"turn": 1, "reason": {"kind": "completed"}})
    send({"method": "session.status", "params": {"sessionId": session, "status": "idle"}})

for line in sys.stdin:
    frame = json.loads(line)
    with open(os.environ["REQUEST_LOG"], "a", encoding="utf-8") as log:
        log.write(line)
    method = frame["method"]
    if method == "initialize":
        send({"id": frame["id"], "result": {"serverInfo": {"name": "query-peer"}}})
    elif method == "session/query":
        serial += 1
        params = frame["params"]
        assert set(params) == {"sessionId", "contentBlocks", "delivery"}
        assert params["delivery"] in ("queue", "steer")
        text = input_text(frame)
        if text == "hold-command":
            pending_commands.append((frame, serial))
        elif text in ("/compact", "/plan Describe this image."):
            command(frame, serial)
        elif text == "silent-command":
            send({"id": frame["id"], "result": {"kind": "command", "execution": {
                "commandId": "silent", "result": {"kind": "success"}}}})
        elif text == "rpc-error":
            send({"id": frame["id"], "error": {"code": -32602, "message": "query rejected"}})
        elif text == "custom-response":
            send({"id": frame["id"], "result": json.loads(os.environ["QUERY_RESPONSE"])})
        elif text == "bad-route":
            send({"id": frame["id"], "result": {"kind": "unknown"}})
        elif text == "bad-execution":
            send({"id": frame["id"], "result": {"kind": "command", "execution": {"commandId": "c"}}})
        else:
            result = {"kind": "prompt", "messageId": "input-" + str(serial)}
            if text == "fast-prompt":
                receipt(frame, serial)
                finish(frame)
                send({"id": frame["id"], "result": result})
            else:
                send({"id": frame["id"], "result": result})
                receipt(frame, serial)
                if text == "hold-prompt":
                    pending_prompts.append(frame)
                else:
                    finish(frame)
    elif method == "release":
        for original, number in pending_commands:
            command(original, number)
        pending_commands.clear()
        for original in pending_prompts:
            finish(original)
        pending_prompts.clear()
        send({"id": frame["id"], "result": {}})
    elif method == "barrier":
        send({"id": frame["id"], "result": {}})
    elif method == "disconnect":
        send({"id": frame["id"], "result": {}})
        break
    elif method == "shutdown":
        send({"id": frame["id"], "result": {}})
        break
    else:
        raise AssertionError(method)
''', encoding="utf-8")
    return script


@pytest.fixture
def sdk(peer: Path, tmp_path: Path):
    with DeepSeekHarness(
        cwd=str(tmp_path), dsh_home=str(tmp_path / "home"), request_timeout_seconds=5,
        _launch_args=(sys.executable, str(peer)),
        env={"REQUEST_LOG": str(tmp_path / "requests.jsonl")},
    ) as harness:
        yield harness


def release(sdk: DeepSeekHarness) -> None:
    sdk.client.request("release", {}, response_model=Ack, timeout_seconds=5)


def assert_released(sdk: DeepSeekHarness) -> None:
    assert sdk.client._responses == {}
    assert sdk.client._notification_subscribers == {}


@pytest.mark.parametrize("entry", ["session", "harness"])
def test_run_returns_command_without_waiting_for_idle(sdk: DeepSeekHarness, entry: str) -> None:
    notifications = []
    result = (sdk.run("/compact", session_id="main", on_notification=notifications.append)
              if entry == "harness" else sdk.start_session("main").run("/compact", on_notification=notifications.append))
    assert isinstance(result, CommandExecution)
    assert result.result.kind == "success"
    assert [notice.payload["event"]["type"] for notice in notifications] == ["command/run", "command/done"]
    assert_released(sdk)


@pytest.mark.parametrize("text", ["ordinary", "fast-prompt", "/model", " /compact extra "])
def test_run_preserves_ordinary_text_and_result(sdk: DeepSeekHarness, text: str) -> None:
    notifications = []
    result = sdk.start_session("main").run(text, on_notification=notifications.append)
    assert isinstance(result, RunResult)
    assert result.final_response == "answer for " + text
    assert result.finish_reason == "completed"
    assert result.notifications == notifications
    assert notifications[0].payload["event"]["type"] == "agent/inbox/spliced"
    assert_released(sdk)


def test_run_accepts_steer_for_text(sdk: DeepSeekHarness) -> None:
    result = sdk.start_session("main").run("next step", delivery="steer")
    assert isinstance(result, RunResult)
    assert result.final_response == "answer for next step"


@pytest.mark.parametrize("entry,text,delivery", [
    ("harness", "/plan Describe this image.", "queue"),
    ("session", "/plan Describe this image.", "steer"),
    ("harness", "Explain this image.", "queue"),
    ("session", "/unknown-slash", "steer"),
    ("session", "", "queue"),
])
def test_run_forwards_content_blocks_with_the_routed_result_and_notifications(
    sdk: DeepSeekHarness, tmp_path: Path, entry: str, text: str, delivery: str,
) -> None:
    blocks = [
        {"type": "text", "text": text},
        {"type": "image", "data": "AQ==", "mimeType": "image/png", "name": "diagram.png"},
    ]
    notifications = []
    result = (
        sdk.run(blocks, session_id="main", delivery=delivery, on_notification=notifications.append)
        if entry == "harness" else sdk.start_session("main").run(
            blocks, delivery=delivery, on_notification=notifications.append,
        )
    )
    if text == "/plan Describe this image.":
        assert isinstance(result, CommandExecution)
        assert [notice.payload["event"]["type"] for notice in notifications] == ["command/run", "command/done"]
    else:
        assert isinstance(result, RunResult)
        assert result.final_response == "answer for " + text
        assert result.notifications == notifications
    sent = [json.loads(line) for line in (tmp_path / "requests.jsonl").read_text(encoding="utf-8").splitlines()]
    assert sent[-1]["method"] == "session/query"
    assert sent[-1]["params"] == {
        "sessionId": "main", "contentBlocks": blocks, "delivery": delivery,
    }
    assert_released(sdk)


def test_run_normalizes_strings_without_changing_their_text(sdk: DeepSeekHarness, tmp_path: Path) -> None:
    result = sdk.run("  preserve whitespace  ", session_id="main")
    assert isinstance(result, RunResult)
    sent = [json.loads(line) for line in (tmp_path / "requests.jsonl").read_text(encoding="utf-8").splitlines()]
    assert sent[-1]["params"] == {
        "sessionId": "main", "contentBlocks": [{"type": "text", "text": "  preserve whitespace  "}], "delivery": "queue",
    }


def test_concurrent_runs_keep_their_own_results(sdk: DeepSeekHarness) -> None:
    session = sdk.start_session("main")
    entered = threading.Event()
    with ThreadPoolExecutor(max_workers=2) as workers:
        first = workers.submit(session.run, "hold-prompt", on_notification=lambda notice: entered.set())
        try:
            assert entered.wait(5), "the first run must observe its receipt"
            second = workers.submit(session.run, "/compact")
            assert isinstance(second.result(timeout=5), CommandExecution)
        finally:
            release(sdk)
        result = first.result(timeout=5)
    assert isinstance(result, RunResult)
    assert result.final_response == "answer for hold-prompt"
    assert_released(sdk)


def test_command_result_needs_no_notifications(sdk: DeepSeekHarness) -> None:
    notices = []
    result = sdk.start_session("main").run("silent-command", on_notification=notices.append)
    assert isinstance(result, CommandExecution)
    assert notices == []
    assert_released(sdk)


@pytest.mark.parametrize("text,error", [("rpc-error", JsonRpcError), ("bad-route", SdkProtocolError), ("bad-execution", SdkProtocolError)])
def test_run_reports_routing_failures_without_retry(sdk: DeepSeekHarness, text: str, error: type[Exception]) -> None:
    session = sdk.start_session("main")
    with pytest.raises(error):
        session.run(text)
    assert_released(sdk)
    assert isinstance(session.run("/compact"), CommandExecution)


@pytest.mark.parametrize("text", ["ordinary", "/compact"])
def test_observer_error_releases_run_subscription(sdk: DeepSeekHarness, text: str) -> None:
    def reject(_notice: Notification) -> None:
        raise RuntimeError("observer failed")
    with pytest.raises(RuntimeError, match="observer failed"):
        sdk.start_session("main").run(text, on_notification=reject)
    assert_released(sdk)
    assert isinstance(sdk.start_session("main").run("after observer"), RunResult)


def test_command_timeout_keeps_runtime_responsive(sdk: DeepSeekHarness) -> None:
    sdk.client.config.request_timeout_seconds = 0.05
    with pytest.raises(TimeoutError, match="session/query timed out"):
        sdk.start_session("main").run("hold-command")
    sdk.client.config.request_timeout_seconds = 5
    assert_released(sdk)
    release(sdk)
    assert isinstance(sdk.start_session("main").run("/compact"), CommandExecution)


def test_run_requires_supported_delivery(sdk: DeepSeekHarness) -> None:
    session = sdk.start_session("main")
    with pytest.raises(ValueError, match="delivery"):
        session.run("ordinary", delivery="unknown")
    with pytest.raises(ValueError, match="delivery"):
        session.run([{"type": "text", "text": "ordinary"}], delivery="unknown")


@pytest.mark.parametrize("response", [
    None, [], {"kind": "unknown"}, {"kind": "prompt"}, {"kind": "prompt", "messageId": ""},
    {"kind": "prompt", "messageId": 4},
    {"kind": "command", "execution": {"commandId": "c"}},
    {"kind": "command", "execution": {"commandId": "c", "result": {"kind": "success", "sourceEventSeq": True}}},
])
def test_run_rejects_invalid_routing_responses_as_protocol_errors(peer: Path, tmp_path: Path, response: object) -> None:
    with DeepSeekHarness(
        cwd=str(tmp_path), dsh_home=str(tmp_path / "home"), request_timeout_seconds=5,
        _launch_args=(sys.executable, str(peer)),
        env={"REQUEST_LOG": str(tmp_path / "requests.jsonl"), "QUERY_RESPONSE": json.dumps(response)},
    ) as sdk:
        with pytest.raises(SdkProtocolError) as raised:
            sdk.start_session("main").run("custom-response")
        if isinstance(response, dict) and response.get("kind") == "command":
            assert isinstance(raised.value.__cause__, ValidationError)
        assert_released(sdk)
        assert isinstance(sdk.start_session("main").run("/compact"), CommandExecution)
