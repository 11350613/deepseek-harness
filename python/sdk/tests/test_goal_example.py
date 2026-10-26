"""Goal observation deadlines and runtime cleanup through the runnable example."""

from __future__ import annotations

import json
import runpy
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest

from deepseek_harness import DeepSeekHarness


_EXAMPLE = Path(__file__).resolve().parents[1] / "examples/goal.py"


@pytest.mark.parametrize("pending", ["command", "goal-event", "wrapup", "complete", "goal-queue", "wrapup-queue"])
def test_goal_example_bounds_pending_work_and_reaps_runtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], pending: str,
) -> None:
    peer = tmp_path / "goal-peer.py"
    observed = tmp_path / "observed.jsonl"
    peer.write_text('''import json
import sys
from pathlib import Path

pending, observed = sys.argv[1:]

def send(frame):
    print(json.dumps({"jsonrpc": "2.0", **frame}), flush=True)

for line in sys.stdin:
    frame = json.loads(line)
    with Path(observed).open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(frame) + "\\n")
    method = frame["method"]
    if method == "initialize":
        send({"id": frame["id"], "result": {"serverInfo": {"name": "goal-example-peer"}}})
    elif method == "session/query":
        assert frame["params"]["contentBlocks"] == [{"type": "text", "text": "/goal Finish this task"}]
        session = frame["params"]["sessionId"]
        if pending == "command":
            continue
        if pending in ("wrapup", "complete", "wrapup-queue"):
            send({"method": "session.event", "params": {"sessionId": session, "event": {
                "type": "goal/change", "data": {"operation": "complete"}}}})
        elif pending == "goal-queue":
            for operation in ("create", "edit"):
                send({"method": "session.event", "params": {"sessionId": session, "event": {
                    "type": "goal/change", "data": {"operation": operation}}}})
        send({"id": frame["id"], "result": {"kind": "command", "execution": {
            "commandId": "goal-command", "result": {"kind": "success", "text": "Goal set"}}}})
    elif method == "session/wait":
        if pending == "wrapup":
            continue
        for _ in range(2 if pending == "wrapup-queue" else 1):
            send({"method": "session.event", "params": {"sessionId": session, "event": {
                "type": "assistant/message", "data": {"message": {
                    "content": [{"type": "text", "text": "Closing reply"}]}}}}})
        send({"id": frame["id"], "result": {}})
    elif method == "shutdown":
        send({"id": frame["id"], "result": {}})
        break
    else:
        raise AssertionError(method)
''', encoding="utf-8")
    example = runpy.run_path(str(_EXAMPLE))
    harnesses: list[DeepSeekHarness] = []

    def configured_harness(**options: object) -> DeepSeekHarness:
        harness = DeepSeekHarness(
            **options, _launch_args=(sys.executable, str(peer), pending, str(observed)),
            initialize_timeout_seconds=10, shutdown_timeout_seconds=10,
        )
        harnesses.append(harness)
        return harness

    monkeypatch.setitem(example["main"].__globals__, "DeepSeekHarness", configured_harness)
    queued = pending in {"goal-queue", "wrapup-queue"}
    displayed = []
    if queued:
        clock = [0.0]
        display = example["display"]

        def advance_after_display(notification):
            event = display(notification)
            if event is not None:
                displayed.append(event["type"])
                if pending == "goal-queue" or event["type"] == "assistant/message":
                    clock[0] = 11.0
            return event

        # Advance only the example clock while the real transport retains its own timeout.
        monkeypatch.setitem(example["main"].__globals__, "time", SimpleNamespace(monotonic=lambda: clock[0]))
        monkeypatch.setitem(example["main"].__globals__, "display", advance_after_display)
    timeout = "10" if pending == "complete" or queued else "1"
    monkeypatch.setattr(sys, "argv", [str(_EXAMPLE), "--dsh-home", str(tmp_path / "home"),
                                     "--workspace", str(tmp_path), "--timeout-seconds", timeout, "Finish this task"])
    # The outer bound also releases an implementation that forgets its own deadline.
    with ThreadPoolExecutor(max_workers=1) as workers:
        execution = workers.submit(example["main"])
        try:
            if pending == "complete":
                execution.result(timeout=30)
            else:
                expected = {"command": "session/query timed out", "goal-event": "SDK notification",
                            "wrapup": "session/wait timed out", "goal-queue": "Goal observation timed out",
                            "wrapup-queue": "Goal observation timed out"}[pending]
                with pytest.raises(TimeoutError, match=expected):
                    execution.result(timeout=30)
        finally:
            for harness in harnesses:
                harness.close()
    [harness] = harnesses
    assert harness.client._proc is None
    frames = [json.loads(line) for line in observed.read_text(encoding="utf-8").splitlines()]
    methods = [frame["method"] for frame in frames]
    assert methods == ["initialize", "session/query",
                       *(["session/wait"] if pending in {"wrapup", "complete", "wrapup-queue"} else []), "shutdown"]
    if queued:
        assert displayed == (["goal/change"] if pending == "goal-queue" else ["goal/change", "assistant/message"])
    if pending == "complete":
        output = capsys.readouterr().out
        assert "Goal: complete" in output
        assert "Closing reply" in output


@pytest.mark.parametrize("timeout", ["0", "-1", "nan", "inf", "-inf"])
def test_goal_example_rejects_unbounded_or_nonpositive_timeout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], timeout: str,
) -> None:
    example = runpy.run_path(str(_EXAMPLE))
    monkeypatch.setattr(sys, "argv", [str(_EXAMPLE), "--dsh-home", str(tmp_path / "home"),
                                     f"--timeout-seconds={timeout}", "Finish this task"])
    with pytest.raises(SystemExit) as error:
        example["main"]()
    assert error.value.code == 2
    assert "timeout-seconds must be finite and positive" in capsys.readouterr().err
