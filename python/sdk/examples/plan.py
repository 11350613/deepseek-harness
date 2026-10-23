#!/usr/bin/env python3
"""Submit a plan command, review its plan, and observe the Session's continuing work."""

from __future__ import annotations

import argparse
import os
import threading
from contextlib import closing
from pathlib import Path

from pydantic import BaseModel

from deepseek_harness import CommandExecution, DeepSeekHarness, Notification, UserQuestionRequest
from deepseek_harness.api import final_response


class WaitResult(BaseModel):
    """The empty session/wait result."""


def review(request: UserQuestionRequest, cancelled: threading.Event) -> dict:
    """Let the user approve, give feedback, or dismiss the native plan review."""
    if cancelled.is_set():
        return {"cancelled": True}
    if len(request.questions) != 1 or request.questions[0].get("intent", {}).get("kind") != "plan-review":
        raise RuntimeError("This example handles plan reviews only")
    question = request.questions[0]
    print(question["detail"])
    try:
        while True:
            choice = input("[a] Approve, [k] Keep planning, [d] Dismiss: ").strip().lower()
            if choice == "d":
                return {"cancelled": True}
            if choice == "a":
                return {"answers": [{"id": question["id"], "selected": ["Approve"]}]}
            if choice == "k":
                return {"answers": [{"id": question["id"], "selected": ["Keep planning"], "custom": input("Feedback: ")}]}
    except EOFError:
        return {"cancelled": True}


def display(notification: Notification, session_id: str) -> None:
    """Print assistant text and report an unsuccessful root Session turn."""
    if notification.method == "session.event":
        event = notification.payload.get("event")
        if isinstance(event, dict) and event.get("type") == "assistant/message":
            text = final_response([event])
            if text:
                print(text)
        elif (isinstance(event, dict) and event.get("type") == "turn/end"
              and notification.payload.get("sessionId") == session_id):
            reason = event["data"]["reason"]
            if reason["kind"] != "completed":
                raise RuntimeError(f"Agent turn ended: {reason}")


def main() -> None:
    """Keep the runtime and question handler alive after the plan command completes."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsh-home", required=True, type=Path)
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    parser.add_argument("--model", default=os.environ.get("DSH_MODEL", "deepseek-v4-flash"))
    parser.add_argument("task", help="Task to plan; implementation waits for your approval")
    args = parser.parse_args()
    if not args.task.strip():
        parser.error("task must be non-blank")
    with DeepSeekHarness(
        dsh_home=str(args.dsh_home.resolve()), cwd=str(args.workspace.resolve()),
        profile="sdk", model=args.model, on_user_question=review,
        env={"DSH_PERMISSION_MODE": "workspace-write"},
    ) as harness:
        session = harness.start_session()
        with closing(harness.client.subscribe_session_notifications(session.id)) as notifications:
            session.query(f"/plan {args.task}")
            for message in session.receive_response():
                if isinstance(message, CommandExecution):
                    print(message.result.text)
                    if message.result.kind == "error":
                        raise RuntimeError(message.result.text)
            harness.client.request(
                "session/wait", {"sessionId": session.id}, response_model=WaitResult,
                on_notification=lambda notice: display(notice, session.id), notification_subscription=notifications,
            )


if __name__ == "__main__":
    main()
