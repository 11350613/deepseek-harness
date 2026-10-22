"""Split query submission and per-request response observation."""
from __future__ import annotations

import sys
import threading
from pathlib import Path

import pytest
from pydantic import BaseModel, ValidationError

from deepseek_harness import CommandExecution, DeepSeekHarness, Notification, RunResult, SdkProtocolError
from deepseek_harness.errors import JsonRpcError, TransportClosedError


class Ack(BaseModel):
    pass


@pytest.fixture
def peer(tmp_path: Path) -> Path:
    script = tmp_path / "queries.py"
    script.write_text('''import json
import sys

serial = 0
pending_commands = []
pending_prompts = []

def send(frame):
    print(json.dumps({"jsonrpc": "2.0", **frame}), flush=True)

def event(session, type, data):
    send({"method": "session.event", "params": {"sessionId": session, "event": {"type": type, "data": data}}})

def command(frame, number):
    session = frame["params"]["sessionId"]
    identity = "command-" + str(number)
    event(session, "command/run", {"commandId": identity})
    event(session, "command/done", {"commandId": identity, "kind": "success"})
    send({"id": frame["id"], "result": {"kind": "command", "execution": {
        "commandId": identity, "result": {"kind": "success", "text": "compacted"}}}})

def receipt(frame, number):
    session = frame["params"]["sessionId"]
    send({"method": "session.status", "params": {"sessionId": session, "status": "idle"}})
    event(session, "agent/inbox/spliced", {"inserted": [{"id": "input-" + str(number)}]})

def finish(frame):
    session = frame["params"]["sessionId"]
    event(session, "assistant/message", {"message": {"content": [
        {"type": "text", "text": "answer for " + frame["params"]["text"]}]}})
    event(session, "turn/end", {"turn": 1, "reason": {"kind": "completed"}})
    send({"method": "session.status", "params": {"sessionId": session, "status": "idle"}})

for line in sys.stdin:
    frame = json.loads(line)
    method = frame["method"]
    if method == "initialize":
        send({"id": frame["id"], "result": {"serverInfo": {"name": "query-peer"}}})
    elif method == "session/query":
        serial += 1
        params = frame["params"]
        assert set(params) == {"sessionId", "text", "delivery"}
        assert params["delivery"] in ("queue", "steer")
        text = params["text"]
        if text == "hold-command":
            pending_commands.append((frame, serial))
        elif text == "/compact":
            command(frame, serial)
        elif text == "silent-command":
            send({"id": frame["id"], "result": {"kind": "command", "execution": {
                "commandId": "silent", "result": {"kind": "success"}}}})
        elif text == "rpc-error":
            send({"id": frame["id"], "error": {"code": -32602, "message": "query rejected"}})
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
    ) as harness:
        yield harness


def release(sdk: DeepSeekHarness) -> None:
    sdk.client.request("release", {}, response_model=Ack, timeout_seconds=5)


def assert_released(sdk: DeepSeekHarness) -> None:
    assert sdk.client._responses == {}
    assert sdk.client._notification_subscribers == {}


def test_query_only_sends_then_receive_returns_command(sdk: DeepSeekHarness) -> None:
    session = sdk.start_session("main")
    assert session.query("hold-command") is None
    assert len(sdk.client._responses) == 1
    release(sdk)
    responses = list(session.receive_response())
    assert [item.payload["event"]["type"] for item in responses[:-1]] == ["command/run", "command/done"]
    assert isinstance(responses[-1], CommandExecution)
    assert responses[-1].command_id == "command-1"
    assert_released(sdk)


@pytest.mark.parametrize("text", ["ordinary", "fast-prompt", "/goal", "/permission"])
@pytest.mark.parametrize("delivery", ["queue", "steer"])
def test_prompt_yields_receipt_through_idle_then_run_result(sdk: DeepSeekHarness, text: str, delivery: str) -> None:
    session = sdk.start_session("main")
    session.query(text, delivery=delivery)
    responses = list(session.receive_response())
    assert all(isinstance(item, Notification) for item in responses[:-1])
    assert responses[0].payload["event"]["type"] == "agent/inbox/spliced"
    result = responses[-1]
    assert isinstance(result, RunResult)
    assert result.final_response == "answer for " + text
    assert result.finish_reason == "completed"
    assert result.notifications == responses[:-1]
    assert len(result.events) == 3
    assert_released(sdk)


def test_late_receive_uses_an_arrived_response_before_expired_deadline(sdk: DeepSeekHarness) -> None:
    session = sdk.start_session("main")
    sdk.client.config.request_timeout_seconds = 0
    session.query("/compact")
    sdk.client.request("barrier", {}, response_model=Ack, timeout_seconds=5)
    assert isinstance(list(session.receive_response())[-1], CommandExecution)
    assert_released(sdk)


def test_pending_response_timeout_releases_only_its_observer(sdk: DeepSeekHarness) -> None:
    session = sdk.start_session("main")
    sdk.client.config.request_timeout_seconds = 0
    session.query("hold-command")
    with pytest.raises(TimeoutError, match="session/query timed out"):
        list(session.receive_response())
    assert_released(sdk)
    release(sdk)


@pytest.mark.parametrize("text,error", [
    ("rpc-error", JsonRpcError), ("bad-route", SdkProtocolError), ("bad-execution", ValidationError),
])
def test_query_errors_arrive_during_receive_and_leave_later_queries_usable(sdk: DeepSeekHarness, text: str, error: type) -> None:
    session = sdk.start_session("main")
    session.query(text)
    with pytest.raises(error):
        list(session.receive_response())
    assert_released(sdk)
    session.query("/compact")
    assert isinstance(list(session.receive_response())[-1], CommandExecution)


def test_receivers_claim_fifo_even_when_responses_arrive_out_of_order(sdk: DeepSeekHarness) -> None:
    session = sdk.start_session("main")
    session.query("hold-command")
    session.query("/compact")
    release(sdk)
    first = session.receive_response()
    second = session.receive_response()
    assert list(second)[-1].command_id == "command-2"
    assert list(first)[-1].command_id == "command-1"
    assert_released(sdk)
    with pytest.raises(RuntimeError, match="preceding query"):
        session.receive_response()


def test_command_receiver_stops_at_its_done_before_a_later_prompt(sdk: DeepSeekHarness) -> None:
    session = sdk.start_session("main")
    session.query("/compact")
    session.query("ordinary")
    sdk.client.request("barrier", {}, response_model=Ack)
    command = list(session.receive_response())
    assert [item.payload["event"]["type"] for item in command[:-1]] == ["command/run", "command/done"]
    assert command[-1].command_id == "command-1"
    prompt = list(session.receive_response())
    assert isinstance(prompt[-1], RunResult)
    assert prompt[-1].final_response == "answer for ordinary"
    assert_released(sdk)


def test_command_result_without_notifications_does_not_wait_for_done(sdk: DeepSeekHarness) -> None:
    session = sdk.start_session("main")
    session.query("silent-command")
    responses = list(session.receive_response())
    assert len(responses) == 1
    assert responses[0].command_id == "silent"
    assert_released(sdk)


@pytest.mark.parametrize("text", ["/compact", "silent-command"])
def test_late_command_receive_preserves_completed_result_after_eof(sdk: DeepSeekHarness, text: str) -> None:
    session = sdk.start_session("main")
    session.query(text)
    sdk.client.request("disconnect", {}, response_model=Ack)
    sdk.client._reader_thread.join(5)
    assert not sdk.client._reader_thread.is_alive()
    responses = list(session.receive_response())
    assert isinstance(responses[-1], CommandExecution)
    assert responses[-1].result.kind == "success"
    if text == "/compact":
        assert [item.payload["event"]["type"] for item in responses[:-1]] == ["command/run", "command/done"]
    else:
        assert len(responses) == 1
    assert_released(sdk)


def test_command_receive_does_not_hide_other_subscription_errors(sdk: DeepSeekHarness, monkeypatch) -> None:
    session = sdk.start_session("main")
    session.query("/compact")
    sdk.client.request("barrier", {}, response_model=Ack)
    receiver = session.receive_response()

    def fail():
        raise SdkProtocolError("invalid notification")

    monkeypatch.setattr(receiver._subscription, "_next_queued", fail)
    with pytest.raises(SdkProtocolError, match="invalid notification"):
        list(receiver)
    assert_released(sdk)


def test_query_and_another_receiver_can_run_while_a_prompt_receiver_waits(sdk: DeepSeekHarness) -> None:
    session = sdk.start_session("main")
    session.query("hold-prompt")
    receiver = session.receive_response()
    entered = threading.Event()
    responses = []
    errors = []

    def receive() -> None:
        try:
            for item in receiver:
                responses.append(item)
                entered.set()
        except BaseException as error:
            errors.append(error)

    thread = threading.Thread(target=receive)
    thread.start()
    try:
        assert entered.wait(5)
        session.query("/compact")
        assert list(session.receive_response())[-1].command_id == "command-2"
        assert thread.is_alive()
        release(sdk)
        thread.join(5)
        assert not thread.is_alive()
        assert not errors
        assert isinstance(responses[-1], RunResult)
        assert responses[-1].final_response == "answer for hold-prompt"
        assert_released(sdk)
    finally:
        receiver.close()
        thread.join(5)


def test_iterator_close_before_first_next_releases_request_and_subscription(sdk: DeepSeekHarness) -> None:
    session = sdk.start_session("main")
    session.query("hold-command")
    receiver = session.receive_response()
    receiver.close()
    receiver.close()
    assert list(receiver) == []
    assert_released(sdk)
    release(sdk)
    session.query("/compact")
    assert list(session.receive_response())[-1].command_id == "command-2"


def test_iterator_close_after_a_prompt_notification_releases_its_subscription(sdk: DeepSeekHarness) -> None:
    session = sdk.start_session("main")
    session.query("hold-prompt")
    receiver = session.receive_response()
    assert isinstance(next(receiver), Notification)
    receiver.close()
    assert list(receiver) == []
    assert_released(sdk)
    release(sdk)


def test_iterator_close_wakes_its_blocked_request_receiver(sdk: DeepSeekHarness, monkeypatch) -> None:
    session = sdk.start_session("main")
    session.query("hold-command")
    receiver = session.receive_response()
    entered = threading.Event()
    errors = []
    original = sdk.client._wait_request

    def wait(request, **kwargs):
        entered.set()
        return original(request, **kwargs)

    monkeypatch.setattr(sdk.client, "_wait_request", wait)

    def receive() -> None:
        try:
            assert list(receiver) == []
        except BaseException as error:
            errors.append(error)

    thread = threading.Thread(target=receive)
    thread.start()
    try:
        assert entered.wait(5)
        receiver.close()
        thread.join(5)
        assert not thread.is_alive()
        assert not errors
        assert_released(sdk)
    finally:
        receiver.close()
        thread.join(5)


def test_terminal_result_releases_resources_before_caller_sends_another_query(sdk: DeepSeekHarness) -> None:
    session = sdk.start_session("main")
    session.query("/compact")
    receiver = session.receive_response()
    for item in receiver:
        if isinstance(item, CommandExecution):
            assert_released(sdk)
            session.query("/compact")
            receiver.close()
    assert list(session.receive_response())[-1].command_id == "command-2"
    assert_released(sdk)


def test_runtime_close_settles_unreceived_queries(sdk: DeepSeekHarness) -> None:
    session = sdk.start_session("main")
    session.query("hold-command")
    sdk.close()
    with pytest.raises(TransportClosedError):
        list(session.receive_response())
    assert_released(sdk)


def test_send_failure_releases_subscription_without_queueing_a_receiver(sdk: DeepSeekHarness, monkeypatch) -> None:
    session = sdk.start_session("main")
    original = sdk.client._write_message

    def write(message):
        if message.get("method") == "session/query":
            raise TransportClosedError("write failed")
        original(message)

    monkeypatch.setattr(sdk.client, "_write_message", write)
    with pytest.raises(TransportClosedError, match="write failed"):
        session.query("ordinary")
    assert_released(sdk)
    with pytest.raises(RuntimeError, match="preceding query"):
        session.receive_response()
