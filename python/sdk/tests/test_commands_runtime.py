"""Exercise Session commands through Python and the real sdk profile with a local model.

The default carrier is the repository's built dsh CLI. Set
DSH_COMMANDS_TEST_RUNTIME=installed to run these same cases against the imported
SDK wheel and its bundled runtime, including from outside the repository.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, Iterator, TypeVar

import pytest

from deepseek_harness import CommandExecution, DeepSeekHarness, Notification, RunResult, Session


_WAIT_SECONDS = 30
_SESSION_ID = "commands-runtime"
_MODEL = "deepseek-v4-flash"
_HISTORY_MARKER = "DSH_COMMANDS_OLD_USER_INPUT"
_FIRST_REPLY = "SDK_COMPACT_READY"
_CHECKPOINT = "## Primary Request and Intent\n- DSH_COMMANDS_CHECKPOINT: retain the earlier task."
_CONTINUE_PROMPT = "DSH_COMMANDS_CONTINUE: answer using the retained checkpoint."
_CONTINUE_REPLY = "SDK_COMPACT_OK"
_T = TypeVar("_T")


@dataclass
class _Completion:
    text: str
    blocked: bool = False
    entered: threading.Event = field(default_factory=threading.Event)
    release: threading.Event = field(default_factory=threading.Event)

    def __post_init__(self) -> None:
        if not self.blocked:
            self.release.set()


def _messages_response(text: str, model: str, ordinal: int) -> bytes:
    events = [
        {"type": "message_start", "message": {
            "id": f"commands-response-{ordinal}", "type": "message", "role": "assistant",
            "model": model, "content": [], "stop_reason": None, "stop_sequence": None,
            "usage": {"input_tokens": 10000, "output_tokens": 0},
        }},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None},
         "usage": {"output_tokens": 32}},
        {"type": "message_stop"},
    ]
    return "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events).encode()


class _ModelServer:
    def __init__(self, completions: list[_Completion]) -> None:
        self.completions = completions
        self.requests: list[dict] = []
        self.failures: list[BaseException] = []
        self.lock = threading.Lock()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def setup(self) -> None:
                self.request.settimeout(_WAIT_SECONDS)
                super().setup()

            def do_POST(self) -> None:
                assert self.path == "/v1/messages", f"unexpected model endpoint: {self.path}"
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                assert isinstance(body, dict) and isinstance(body.get("model"), str)
                with owner.lock:
                    ordinal = len(owner.requests)
                    owner.requests.append(body)
                    assert ordinal < len(owner.completions), "unexpected additional model request"
                    completion = owner.completions[ordinal]
                completion.entered.set()
                # The test owns release. This larger bound only contains a failed test.
                assert completion.release.wait(_WAIT_SECONDS * 2), "model barrier was not released"
                payload = _messages_response(completion.text, body["model"], ordinal)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                self.wfile.flush()

            def log_message(self, _format: str, *_args: object) -> None:
                pass

        class Server(ThreadingHTTPServer):
            # server_close joins request handlers after their barriers are released.
            daemon_threads = False

            def handle_error(self, _request: object, _client_address: object) -> None:
                error = sys.exc_info()[1]
                assert error is not None
                with owner.lock:
                    owner.failures.append(error)

        self.server = Server(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, name="commands-model", daemon=True)
        host, port = self.server.server_address
        self.url = f"http://{host}:{port}"

    def __enter__(self) -> _ModelServer:
        try:
            self.thread.start()
        except BaseException:
            self.server.server_close()
            raise
        return self

    def release_all(self) -> None:
        for completion in self.completions:
            completion.release.set()

    def captured(self) -> list[dict]:
        with self.lock:
            return list(self.requests)

    def __exit__(self, exc_type: object, _exc: object, _tb: object) -> None:
        self.release_all()
        self.server.shutdown()
        try:
            self.server.server_close()
        finally:
            self.thread.join(_WAIT_SECONDS)
        assert not self.thread.is_alive(), "model listener did not stop"
        if exc_type is None:
            assert not self.failures, [repr(error) for error in self.failures]


def _dsh_bin() -> str | None:
    mode = os.environ.get("DSH_COMMANDS_TEST_RUNTIME", "built")
    if mode == "installed":
        return None
    if mode != "built":
        raise ValueError("DSH_COMMANDS_TEST_RUNTIME must be built or installed")
    repo = Path(__file__).resolve().parents[3]
    node = shutil.which("node")
    binary = repo / "apps/cli/lib/bin.js"
    if node is None or not binary.is_file():
        pytest.skip("requires Node and built dsh CLI, or DSH_COMMANDS_TEST_RUNTIME=installed")
    return str(binary)


@dataclass
class _Runtime:
    harness: DeepSeekHarness
    model: _ModelServer
    workers: ThreadPoolExecutor
    logs: Path

    def call(self, operation: Callable[..., _T], *args: object, **kwargs: object) -> _T:
        return self.workers.submit(operation, *args, **kwargs).result(timeout=_WAIT_SECONDS)


@contextmanager
def _runtime(
    tmp_path: Path, completions: list[_Completion], *, capture_patch: Path | None = None,
    initial_permission: str = "danger-full-access",
) -> Iterator[_Runtime]:
    workspace = tmp_path / "workspace"
    workspace.mkdir(exist_ok=True)
    home = tmp_path / "home"
    logs = tmp_path / "sessions"
    patch = tmp_path / "commands.patch.yml"
    # Raw JSONL permits an independent read at the compaction durability boundary.
    patch.write_text(
        "- id: session-persistence-jsonl\n  config:\n    root: " + json.dumps(str(logs))
        + "\n    compression: none\n",
        encoding="utf-8",
    )
    patches = (patch,) if capture_patch is None else (patch, capture_patch.resolve())
    dsh_bin = _dsh_bin()
    with _ModelServer(completions) as model, ThreadPoolExecutor(max_workers=2) as workers:
        harness = DeepSeekHarness(
            cwd=str(workspace), runtime_cwd=str(workspace), dsh_home=str(home),
            dsh_bin=dsh_bin, profile="sdk", patches=tuple(str(item) for item in patches), model=_MODEL,
            base_url=model.url, api_key="keyless-commands-runtime",
            initialize_timeout_seconds=60, request_timeout_seconds=20, shutdown_timeout_seconds=20,
            env={"DSH_PERMISSION_MODE": initial_permission,
                 "DSH_TELEMETRY_DISABLED": "1", "DSH_TOOLS_MODE": "native"},
        )
        try:
            harness.start()
            yield _Runtime(harness, model, workers, logs)
        finally:
            # Also covers failed initialization: release HTTP, close the client, then join callers.
            model.release_all()
            harness.close()


def _read_events(root: Path, *, live: bool = False, session_id: str = _SESSION_ID) -> list[dict]:
    paths = []
    for path in root.rglob("session*.jsonl"):
        with path.open(encoding="utf-8") as log:
            header = json.loads(log.readline())
        if header.get("id") == session_id:
            paths.append(path)
    assert len(paths) == 1, f"expected one Session log for {session_id}, found {paths}"
    content = paths[0].read_bytes()
    if not live:
        assert content.endswith(b"\n"), "closed Session log has an incomplete final row"
    # A live writer may append an unflushed suffix after the checkpoint we inspect.
    complete = content[:content.rfind(b"\n") + 1]
    records = [json.loads(line) for line in complete.splitlines()]
    assert records and records[0]["type"] == "session"
    assert records[0]["id"] == session_id
    events = records[1:]
    for seq, event in enumerate(events):
        assert isinstance(event, dict)
        assert event.setdefault("seq", seq) == seq
    return events


def _of_type(events: list[dict], name: str) -> list[dict]:
    return [event for event in events if event["type"] == name]


def _command_pair(events: list[dict], execution: CommandExecution, name: str = "compact") -> None:
    runs = [event for event in _of_type(events, "command/run")
            if event["data"]["commandId"] == execution.command_id]
    done = [event for event in _of_type(events, "command/done")
            if event["data"]["commandId"] == execution.command_id]
    assert len(runs) == len(done) == 1
    assert runs[0]["data"]["name"] == name
    assert runs[0]["seq"] < done[0]["seq"]
    assert done[0]["data"]["kind"] == execution.result.kind
    assert done[0]["data"].get("text") == execution.result.text


def _text_blocks(content: object) -> list[str]:
    if isinstance(content, str):
        return [content]
    assert isinstance(content, list)
    return [block["text"] for block in content if block.get("type") == "text"]


def _request_texts(request: dict) -> list[str]:
    return [text for message in request["messages"] for text in _text_blocks(message["content"])]


def _receive_result(
    session: Session, response_claimed: threading.Event | None = None,
) -> RunResult | CommandExecution:
    result: RunResult | CommandExecution | None = None
    with closing(session.receive_response()) as responses:
        if response_claimed is not None:
            response_claimed.set()
        for item in responses:
            assert result is None, "receive_response yielded another item after its terminal result"
            if not isinstance(item, Notification):
                assert isinstance(item, (RunResult, CommandExecution)), type(item)
                result = item
    assert result is not None, "receive_response ended without a terminal result"
    return result


def _wait_command_done(next_notification: Callable[[], Notification]) -> dict:
    while True:
        notification = next_notification()
        if notification.method != "session.event" or notification.payload.get("sessionId") != _SESSION_ID:
            continue
        event = notification.payload.get("event")
        if isinstance(event, dict) and event.get("type") == "command/done":
            return event["data"]


def test_compact_without_history_returns_without_a_model_turn(tmp_path: Path) -> None:
    with _runtime(tmp_path, []) as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        observer = runtime.harness.client.subscribe_session_notifications(_SESSION_ID)
        try:
            assert runtime.call(session.query, " \n/压缩\t ", delivery="queue") is None
            # Wait independently for completion before starting the query's receiver.
            done = runtime.call(_wait_command_done, observer.next)
            execution = runtime.call(_receive_result, session)
        except BaseException:
            # Wake a timed-out observer before unregistering its otherwise blocking queue.
            runtime.harness.close()
            raise
        finally:
            observer.close()
        assert isinstance(execution, CommandExecution)
        assert done["commandId"] == execution.command_id
        assert execution.result.kind == "success"
        assert execution.result.source_event_seq is None
        assert runtime.model.captured() == []
    events = _read_events(runtime.logs)
    _command_pair(events, execution)
    assert not {event["type"] for event in events} & {
        "turn/start", "step/start", "request/header", "compaction/start", "user/message",
    }


def test_compact_rejects_busy_agent_before_the_model_is_released(tmp_path: Path) -> None:
    response = _Completion("DSH_COMMANDS_BUSY_REPLY", blocked=True)
    with _runtime(tmp_path, [response]) as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        sending = runtime.workers.submit(
            session.query, "Hold this request while compaction is attempted.", delivery="queue",
        )
        assert response.entered.wait(_WAIT_SECONDS), runtime.model.failures
        assert sending.result(timeout=_WAIT_SECONDS) is None
        assert not response.release.is_set(), "query waited for the model before returning"

        # Claim the prompt's FIFO slot before issuing the command for another receiver.
        receiving = threading.Event()
        running = runtime.workers.submit(_receive_result, session, receiving)
        assert receiving.wait(_WAIT_SECONDS), runtime.model.failures
        assert not running.done()
        assert runtime.call(session.query, "/compact", delivery="queue") is None
        execution = runtime.call(_receive_result, session)
        assert isinstance(execution, CommandExecution)
        assert execution.result.kind == "error"
        assert not response.release.is_set()
        assert not running.done()
        assert len(runtime.model.captured()) == 1
        response.release.set()
        completed = running.result(timeout=_WAIT_SECONDS)
        assert isinstance(completed, RunResult)
        assert completed.final_response == response.text
    events = _read_events(runtime.logs)
    _command_pair(events, execution)
    assert len(_of_type(events, "turn/start")) == len(_of_type(events, "turn/end")) == 1
    assert not _of_type(events, "compaction/start")


def run_compaction_scenario(tmp_path: Path, *, capture_patch: Path | None = None) -> Path:
    """Run the complete scenario and retain its real Session log under the caller's directory."""
    summary_response = _Completion(_CHECKPOINT, blocked=True)
    with _runtime(
        tmp_path, [_Completion(_FIRST_REPLY), summary_response, _Completion(_CONTINUE_REPLY)],
        capture_patch=capture_patch,
    ) as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        # The replaced span is deliberately larger than the framed summary.
        prompt = _HISTORY_MARKER + "\n" + "Keep the original request only in the stored history. " * 256
        assert runtime.call(session.query, prompt, delivery="queue") is None
        first_result = runtime.call(_receive_result, session)
        assert isinstance(first_result, RunResult)
        assert first_result.final_response == _FIRST_REPLY

        sending = runtime.workers.submit(session.query, "/compact", delivery="queue")
        assert summary_response.entered.wait(_WAIT_SECONDS), runtime.model.failures
        assert sending.result(timeout=_WAIT_SECONDS) is None
        assert not summary_response.release.is_set(), "query waited for the summary before returning"
        receiving = threading.Event()
        compacting = runtime.workers.submit(_receive_result, session, receiving)
        assert receiving.wait(_WAIT_SECONDS), runtime.model.failures
        assert not compacting.done(), "command returned before its summary request completed"
        summary_response.release.set()
        execution = compacting.result(timeout=_WAIT_SECONDS)
        assert isinstance(execution, CommandExecution)
        assert execution.result.kind == "success"
        assert execution.result.source_event_seq is not None

        # The native compactor promises this prefix before returning, unlike command/done.
        checkpointed = _read_events(runtime.logs, live=True)
        summaries = _of_type(checkpointed, "compaction/summary")
        starts = _of_type(checkpointed, "compaction/start")
        ends = _of_type(checkpointed, "compaction/end")
        assert len(starts) == len(summaries) == len(ends) == 1
        summary = summaries[0]
        assert summary["seq"] == execution.result.source_event_seq
        assert summary["data"]["llmStreamCall"] is True
        assert summary["data"]["provider"] == "deepseek-official"
        assert summary["data"]["model"] == _MODEL
        for event in [starts[0], summary, ends[0]]:
            assert event["data"]["sourceCommandId"] == execution.command_id
            assert event["data"]["compactionId"] == summary["data"]["compactionId"]
        assert starts[0]["data"]["turn"] is None and ends[0]["data"]["turn"] is None
        assert "error" not in ends[0]["data"]
        checkpoint = checkpointed[summary["seq"] + 1]
        assert checkpoint["type"] == "user/message"
        assert checkpoint["data"]["source"]["kind"] == "compact-checkpoint"
        assert checkpoint["surfaceOp"]["op"] == "replace"
        checkpoint_text = "\n".join(_text_blocks(checkpoint["data"]["content"]))
        assert _CHECKPOINT in checkpoint_text
        assert "<compacted-summary>" in checkpoint_text and "</compacted-summary>" in checkpoint_text
        assert len(_of_type(checkpointed, "turn/start")) == len(_of_type(checkpointed, "turn/end")) == 1

        assert runtime.call(session.query, _CONTINUE_PROMPT, delivery="queue") is None
        continued = runtime.call(_receive_result, session)
        assert isinstance(continued, RunResult)
        assert continued.final_response == _CONTINUE_REPLY
        first, compaction, following = runtime.model.captured()
        assert first["system"] == compaction["system"]
        assert first["tools"] == compaction["tools"]
        initial_texts = _request_texts(first)
        summary_texts = _request_texts(compaction)
        assert summary_texts[:len(initial_texts)] == initial_texts
        assert "You are now acting as a compaction engine" in summary_texts[-1]
        following_texts = _request_texts(following)
        following_text = "\n".join(following_texts)
        assert _CHECKPOINT in following_text and _CONTINUE_PROMPT in following_text
        assert _FIRST_REPLY in following_text
        assert _HISTORY_MARKER not in following_text
        assert "/compact" not in following_texts
        assert execution.result.text not in following_text

    events = _read_events(runtime.logs)
    _command_pair(events, execution)
    assert len(_of_type(events, "turn/start")) == len(_of_type(events, "turn/end")) == 2
    assert len(_of_type(events, "step/start")) == len(_of_type(events, "step/end")) == 2
    assert _HISTORY_MARKER in json.dumps(events), "compaction erased the original stored input"
    return next(runtime.logs.rglob("session*.jsonl"))


def test_compact_checkpoints_history_before_continuing_the_same_session(tmp_path: Path) -> None:
    run_compaction_scenario(tmp_path)


def test_unknown_slash_and_compact_arguments_follow_the_plain_prompt_path(tmp_path: Path) -> None:
    prompts = ["/sdk-unregistered-command-fixture", "/compact extra"]
    replies = ["SDK_UNKNOWN_SLASH_REPLY", "SDK_COMPACT_ARGUMENTS_REPLY"]
    with _runtime(tmp_path, [_Completion(text) for text in replies]) as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        for prompt, reply in zip(prompts, replies):
            assert runtime.call(session.query, prompt, delivery="queue") is None
            result = runtime.call(_receive_result, session)
            assert isinstance(result, RunResult)
            assert result.final_response == reply
        requests = runtime.model.captured()
        assert len(requests) == len(prompts)
        for prompt, request in zip(prompts, requests):
            assert prompt in _request_texts(request)
    events = _read_events(runtime.logs)
    assert not _of_type(events, "command/run")
    assert not _of_type(events, "compaction/start")
    assert len(_of_type(events, "turn/start")) == len(_of_type(events, "turn/end")) == 2


def test_unimplemented_slash_remains_plain_text_without_changing_plan_mode(tmp_path: Path) -> None:
    plan_text = "/plan DSH_PLAN_TEXT_INPUT"
    following = "DSH_AFTER_PLAN_TEXT_INPUT"
    plan_reply = "DSH_PLAN_TEXT_REPLY"
    reply = "DSH_AFTER_PLAN_TEXT_REPLY"
    with _runtime(tmp_path, [_Completion(plan_reply), _Completion(reply)]) as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        assert runtime.call(session.query, plan_text, delivery="queue") is None
        first = runtime.call(_receive_result, session)
        assert isinstance(first, RunResult)
        assert first.final_response == plan_reply

        assert runtime.call(session.query, following, delivery="queue") is None
        result = runtime.call(_receive_result, session)
        assert isinstance(result, RunResult)
        assert result.final_response == reply
        initial, continued = runtime.model.captured()
        assert plan_text in _request_texts(initial)
        assert following in _request_texts(continued)
        assert initial["tools"] == continued["tools"]
    events = _read_events(runtime.logs)
    assert not _of_type(events, "command/run")
    assert not any(event["data"].get("active") is True for event in _of_type(events, "plan/mode"))
    assert len(_of_type(events, "turn/start")) == len(_of_type(events, "turn/end")) == 2


_PERMISSION_FACTS = {"permission/preset", "sandbox/mode", "approval/policy"}
_ASK_POLICY = "Approval policy: ask."
_NEVER_POLICY = "Approval prompts are disabled in this session"


def _assert_request_permission(request: dict, sandbox: str, approval: str) -> None:
    contexts = [text for text in _request_texts(request) if text.startswith("Current runtime context.")]
    assert contexts, "model request has no runtime-context snapshot"
    assert f"Current DSH file policy: {sandbox}." in contexts[-1]
    assert (_ASK_POLICY if approval == "ask" else _NEVER_POLICY) in contexts[-1]


def _permission_facts(events: list[dict]) -> list[dict]:
    return [{"type": event["type"], "data": event["data"]}
            for event in events if event["type"] in _PERMISSION_FACTS]


def _permission_command(runtime: _Runtime, session: Session, preset: str) -> CommandExecution:
    assert runtime.call(session.query, f"/permission {preset}") is None
    result = runtime.call(_receive_result, session)
    assert isinstance(result, CommandExecution)
    return result


def test_permission_changes_only_the_selected_session_and_retains_prompt_semantics(tmp_path: Path) -> None:
    completions = [_Completion(f"PERMISSION_REPLY_{index}") for index in range(9)]
    with _runtime(tmp_path, completions, initial_permission="workspace-write") as runtime:
        main = runtime.harness.start_session(_SESSION_ID)
        other = runtime.harness.start_session("permission-other")
        initial_config = dict(runtime.harness.config.env)
        for session, text in [(main, "Initial main policy; do not use tools."),
                              (other, "Initial other policy; do not use tools.")]:
            runtime.call(session.query, text)
            assert isinstance(runtime.call(_receive_result, session), RunResult)

        readonly = _permission_command(runtime, main, "read-only")
        invalid = _permission_command(runtime, main, "no-such-preset")
        repeated = _permission_command(runtime, main, "read-only")
        assert readonly.result.kind == repeated.result.kind == "success"
        assert invalid.result.kind == "error"
        assert "unknown preset" in invalid.result.text
        assert len(runtime.model.captured()) == 2, "idle permission commands woke the model"

        runtime.call(main.query, "Read-only policy after a plain query; do not use tools.")
        assert isinstance(runtime.call(_receive_result, main), RunResult)
        full = _permission_command(runtime, main, "danger-full-access")
        assert full.result.kind == "success"
        assert len(runtime.model.captured()) == 3
        runtime.call(main.query, "Full policy after a plain query; do not use tools.")
        assert isinstance(runtime.call(_receive_result, main), RunResult)
        restored = _permission_command(runtime, main, "workspace-write")
        assert restored.result.kind == "success"
        runtime.call(main.query, "Switched-back policy; do not use tools.")
        assert isinstance(runtime.call(_receive_result, main), RunResult)

        for session in [other, runtime.harness.start_session("permission-new")]:
            runtime.call(session.query, "Report your own policy; do not use tools.")
            assert isinstance(runtime.call(_receive_result, session), RunResult)
        ordinary = runtime.call(main.run, "/permission danger-full-access")
        assert isinstance(ordinary, RunResult)
        runtime.call(main.query, "/permission")
        assert isinstance(runtime.call(_receive_result, main), RunResult)
        assert runtime.harness.config.env == initial_config

        requests = runtime.model.captured()
        assert len(requests) == 9
        for index in [0, 1, 4, 5, 6, 7, 8]:
            _assert_request_permission(requests[index], "workspace-write", "ask")
        _assert_request_permission(requests[2], "read-only", "ask")
        _assert_request_permission(requests[3], "danger-full-access", "never")
        assert 'The approval policy changed from "ask" to "never" (changed by the user).' in _request_texts(requests[3])
        assert 'The approval policy changed from "never" to "ask" (changed by the user).' in _request_texts(requests[4])
        for index in [2, 3, 4]:
            assert requests[index]["system"] == requests[0]["system"]
            assert requests[index]["tools"] == requests[0]["tools"]
        assert "/permission danger-full-access" in _request_texts(requests[7])
        assert "/permission" in _request_texts(requests[8])

    events = _read_events(runtime.logs)
    executions = [readonly, invalid, repeated, full, restored]
    assert len(_of_type(events, "command/run")) == len(executions)
    for execution in executions:
        _command_pair(events, execution, "permission")
    for execution in [invalid, repeated]:
        start = next(event["seq"] for event in _of_type(events, "command/run")
                     if event["data"]["commandId"] == execution.command_id)
        done = next(event["seq"] for event in _of_type(events, "command/done")
                    if event["data"]["commandId"] == execution.command_id)
        assert not _permission_facts(events[start + 1:done])
    for session_id in [_SESSION_ID, "permission-other", "permission-new"]:
        state = {event["type"]: event["data"] for event in _permission_facts(_read_events(runtime.logs, session_id=session_id))}
        assert state["permission/preset"] == {"preset": "workspace-write"}
        assert state["sandbox/mode"]["mode"] == "workspace-write"
        assert state["approval/policy"] == {"policy": "ask"}


def test_running_permission_change_keeps_the_native_extra_step_and_notifications(tmp_path: Path) -> None:
    first = _Completion("PERMISSION_FIRST_DONE", blocked=True)
    second = _Completion("PERMISSION_SWITCH_SEEN")
    with _runtime(tmp_path, [first, second], initial_permission="workspace-write") as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        runtime.call(session.query, "Wait for the policy change, then finish without tools.")
        assert first.entered.wait(_WAIT_SECONDS), runtime.model.failures
        claimed = threading.Event()
        observing = runtime.workers.submit(_receive_result, session, claimed)
        assert claimed.wait(_WAIT_SECONDS)
        execution = _permission_command(runtime, session, "danger-full-access")
        assert execution.result.kind == "success"
        assert not first.release.is_set()
        assert not observing.done()
        assert len(runtime.model.captured()) == 1
        first.release.set()
        result = observing.result(timeout=_WAIT_SECONDS)
        assert isinstance(result, RunResult)
        assert result.final_response == second.text
        requests = runtime.model.captured()
        assert len(requests) == 2
        _assert_request_permission(requests[0], "workspace-write", "ask")
        _assert_request_permission(requests[1], "danger-full-access", "never")
        assert requests[0]["system"] == requests[1]["system"]
        assert requests[0]["tools"] == requests[1]["tools"]
        notice = 'The approval policy changed from "ask" to "never" (changed by the user).'
        assert notice not in _request_texts(requests[0])
        assert notice in _request_texts(requests[1])
        assert runtime.harness.config.env["DSH_PERMISSION_MODE"] == "workspace-write"
    events = _read_events(runtime.logs)
    _command_pair(events, execution, "permission")
    assert [event["data"] for event in _of_type(events, "step/start")] == [
        {"turn": 1, "step": 1}, {"turn": 1, "step": 2},
    ]
    assert len(_of_type(events, "turn/start")) == len(_of_type(events, "turn/end")) == 1


def test_resumed_permission_survives_different_launch_defaults(tmp_path: Path) -> None:
    with _runtime(tmp_path, [], initial_permission="workspace-write") as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        execution = _permission_command(runtime, session, "read-only")
        assert execution.result.kind == "success"
        assert runtime.model.captured() == []
    saved = _permission_facts(_read_events(runtime.logs))
    with _runtime(tmp_path, [_Completion("RESUMED_PERMISSION")], initial_permission="danger-full-access") as resumed:
        session = resumed.call(resumed.harness.resume_session, _SESSION_ID)
        resumed.call(session.query, "Report the restored policy without using tools.")
        assert isinstance(resumed.call(_receive_result, session), RunResult)
        [request] = resumed.model.captured()
        _assert_request_permission(request, "read-only", "ask")
        assert resumed.harness.config.env["DSH_PERMISSION_MODE"] == "danger-full-access"
    assert _permission_facts(_read_events(resumed.logs)) == saved
