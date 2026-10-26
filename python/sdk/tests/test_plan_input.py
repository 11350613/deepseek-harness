"""Plan example input uses real pipes and releases readers before process exit."""

from __future__ import annotations

import json
import os
import runpy
import signal
import subprocess
import sys
import threading
import time
from contextlib import ExitStack
from pathlib import Path

import pytest


_EXAMPLE = Path(__file__).resolve().parents[1] / "examples/plan.py"
_WAIT_SECONDS = 15
_PEER = '''import json
from pathlib import Path
import sys
import threading

root = Path(sys.argv[1])
lock = threading.Lock()
stop = threading.Event()
wait_id = None
serial = 0

def send(frame):
    with lock:
        print(json.dumps({"jsonrpc": "2.0", **frame}), flush=True)

def ask(session_id):
    global serial
    serial += 1
    send({"id": "ask-" + str(serial), "method": "user-question/ask", "params": {
        "requestId": "review-" + str(serial), "sessionId": session_id,
        "questions": [{"id": "plan-review", "question": "Review the plan?", "detail": "# Small change",
                       "options": [{"label": "Approve"}, {"label": "Keep planning"}],
                       "intent": {"kind": "plan-review", "approve": "Approve"}}],
    }})

def cancel():
    while not stop.wait(0.01):
        if (root / "cancel").exists():
            send({"method": "user-question.cancelled", "params": {"requestId": "review-1"}})
            send({"id": wait_id, "result": {}})
            return

watcher = threading.Thread(target=cancel)
watcher.start()
try:
    for line in sys.stdin:
        frame = json.loads(line)
        method = frame.get("method")
        if method is None:
            with (root / "answers.jsonl").open("a") as output:
                output.write(json.dumps(frame) + "\\n")
            result = frame.get("result", {})
            answers = result.get("answers", [])
            if answers and answers[0].get("selected") == ["Keep planning"]:
                ask(session_id)
            else:
                send({"id": wait_id, "result": {}})
        elif method == "initialize":
            send({"id": frame["id"], "result": {"serverInfo": {"name": "plan-input-peer"}}})
        elif method == "session/query":
            send({"id": frame["id"], "result": {"kind": "command", "execution": {
                "commandId": "plan-command", "result": {"kind": "success", "text": "Plan mode entered"}}}})
        elif method == "session/wait":
            wait_id = frame["id"]
            session_id = frame["params"]["sessionId"]
            ask(session_id)
        elif method == "shutdown":
            (root / "shutdown").write_text("done")
            send({"id": frame["id"], "result": {}})
            break
        else:
            raise AssertionError(method)
finally:
    stop.set()
    watcher.join()
'''
_WRAPPER = '''import json
from pathlib import Path
import runpy
import subprocess
import sys
import threading
from deepseek_harness import DeepSeekHarness

if sys.platform != "win32":
    import resource
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

example_path, peer, root_argument, stdin_encoding = sys.argv[1:]
if stdin_encoding:
    sys.stdin.reconfigure(encoding=stdin_encoding)
root = Path(root_argument)
example = runpy.run_path(example_path)
readers = []
popen = subprocess.Popen

def record_reader(*args, **kwargs):
    process = popen(*args, **kwargs)
    if args and len(args[0]) > 1 and args[0][1] == "-c":
        readers.append(process)
    return process

subprocess.Popen = record_reader

def configured_harness(**options):
    answer = options.pop("on_user_question")
    def record_answer(request, cancelled):
        result = answer(request, cancelled)
        with (root / "callbacks.jsonl").open("a") as output:
            output.write(json.dumps(result) + "\\n")
        return result
    return DeepSeekHarness(
        **options, on_user_question=record_answer, _launch_args=(sys.executable, peer, str(root)),
        initialize_timeout_seconds=5, shutdown_timeout_seconds=1,
    )

example["main"].__globals__["DeepSeekHarness"] = configured_harness
sys.argv = [example_path, "--dsh-home", str(root / "home"), "--workspace", str(root), "Plan a change."]
try:
    example["main"]()
except KeyboardInterrupt:
    raise SystemExit(130)
finally:
    (root / "cleanup.json").write_text(json.dumps({
        "readers": [{"pid": reader.pid, "returncode": reader.poll()} for reader in readers],
        "callbacks": [thread.name for thread in threading.enumerate() if thread.name == "dsh-user-question"],
    }))
'''


def _wait_prompt(process: subprocess.Popen[bytes], output: Path, marker: str) -> None:
    deadline = time.monotonic() + _WAIT_SECONDS
    while marker not in output.read_text(encoding="utf-8"):
        assert process.poll() is None, output.read_text(encoding="utf-8")
        if time.monotonic() >= deadline:
            raise AssertionError(f"plan input did not reach {marker!r}")
        time.sleep(0.01)


def _run(
    tmp_path: Path, data: bytes, *, stage: str | None = None, action: str | None = None, terminal: bool = False,
    stdin_encoding: str | None = None, python_args: tuple[str, ...] = (), env: dict[str, str] | None = None,
) -> list[dict]:
    peer = tmp_path / "peer.py"
    peer.write_text(_PEER, encoding="utf-8")
    wrapper = tmp_path / "wrapper.py"
    wrapper.write_text(_WRAPPER, encoding="utf-8")
    output = tmp_path / "stdout.txt"
    errors = tmp_path / "stderr.txt"
    if env is None:
        env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    with ExitStack() as stack, output.open("wb") as stdout, errors.open("wb") as stderr:
        if terminal:
            master, slave = os.openpty()
            writing = stack.enter_context(os.fdopen(master, "wb", buffering=0))
            reading = stack.enter_context(os.fdopen(slave, "rb", buffering=0))
            child_input = reading
        else:
            child_input = subprocess.PIPE
        process = subprocess.Popen(
            [sys.executable, *python_args, str(wrapper), str(_EXAMPLE), str(peer), str(tmp_path), stdin_encoding or ""],
            stdin=child_input, stdout=stdout, stderr=stderr, env=env, start_new_session=os.name != "nt",
        )
        if not terminal:
            assert process.stdin is not None
            writing = stack.enter_context(process.stdin)
        try:
            if data:
                writing.write(data)
                writing.flush()
            if action is None and not terminal:
                writing.close()
            elif action is not None:
                marker = "Feedback: " if stage == "feedback" else "[d] Dismiss: "
                _wait_prompt(process, output, marker)
                if action == "interrupt":
                    process.send_signal(signal.SIGINT)
                else:
                    (tmp_path / "cancel").write_text("cancel")
            expected = 130 if action == "interrupt" else 0
            assert process.wait(timeout=_WAIT_SECONDS) == expected, errors.read_text(encoding="utf-8")
        finally:
            if os.name != "nt":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError as error:
                    # Successful example teardown has already removed the process group.
                    pass
            elif process.poll() is None:
                taskkill = Path(os.environ["SystemRoot"]) / "System32" / "taskkill.exe"
                subprocess.run([str(taskkill), "/PID", str(process.pid), "/T", "/F"],
                               stdin=subprocess.DEVNULL, capture_output=True, check=False, timeout=_WAIT_SECONDS)
            process.wait(timeout=_WAIT_SECONDS)
    assert "_enter_buffered_busy" not in errors.read_text(encoding="utf-8")
    assert (tmp_path / "shutdown").read_text() == "done"
    cleanup = json.loads((tmp_path / "cleanup.json").read_text())
    assert cleanup["readers"] and all(reader["returncode"] is not None for reader in cleanup["readers"])
    assert cleanup["callbacks"] == []
    answers = tmp_path / "answers.jsonl"
    if answers.is_file():
        responses = [json.loads(line) for line in answers.read_text().splitlines()]
        assert not [response for response in responses if "error" in response], responses
    return [json.loads(line) for line in (tmp_path / "callbacks.jsonl").read_text().splitlines()]


@pytest.mark.parametrize("data,expected", [
    (b"a", [{"answers": [{"id": "plan-review", "selected": ["Approve"]}]}]),
    (b"d\n", [{"cancelled": True}]),
    (b"", [{"cancelled": True}]),
    ("invalid\nk\n继续检查\r\nd\n".encode(), [
        {"answers": [{"id": "plan-review", "selected": ["Keep planning"], "custom": "继续检查"}]},
        {"cancelled": True},
    ]),
])
def test_plan_input_preserves_piped_lines_and_eof(tmp_path: Path, data: bytes, expected: list[dict]) -> None:
    assert _run(tmp_path, data) == expected


def test_plan_input_preserves_reconfigured_stdin_feedback(tmp_path: Path) -> None:
    assert _run(tmp_path, "k\nréviser\nd\n".encode("latin-1"), stdin_encoding="latin-1") == [
        {"answers": [{"id": "plan-review", "selected": ["Keep planning"], "custom": "réviser"}]},
        {"cancelled": True},
    ]


def test_plan_input_print_failure_reaps_reader_before_owner_exit(monkeypatch: pytest.MonkeyPatch) -> None:
    example = runpy.run_path(str(_EXAMPLE))
    owner_type = example["_PlanReviews"]
    readers = []
    popen = subprocess.Popen

    def record_reader(*args, **kwargs):
        reader = popen(*args, **kwargs)
        readers.append(reader)
        return reader

    def fail_print(*_args, **_kwargs):
        raise BrokenPipeError("terminal output closed")

    with ExitStack() as stack, monkeypatch.context() as patch:
        read_fd, write_fd = os.pipe()
        terminal = stack.enter_context(os.fdopen(read_fd, "r", encoding="utf-8"))
        stack.enter_context(os.fdopen(write_fd, "w", encoding="utf-8"))
        patch.setattr(sys, "stdin", terminal)
        patch.setattr(subprocess, "Popen", record_reader)
        patch.setitem(owner_type._read_line.__globals__, "print", fail_print)
        with owner_type() as owner:
            with pytest.raises(BrokenPipeError, match="terminal output closed"):
                owner._read_line("Review: ", threading.Event())
            assert len(readers) == 1 and readers[0].poll() is not None
            assert owner._readers == []


@pytest.mark.parametrize("stage", ["choice", "feedback"])
def test_plan_input_cancellation_reaps_open_pipe_reader(tmp_path: Path, stage: str) -> None:
    data = b"k\npartial feedback" if stage == "feedback" else b"partial choice"
    assert _run(tmp_path, data, stage=stage, action="protocol") == [{"cancelled": True}]
    assert not (tmp_path / "answers.jsonl").exists()
