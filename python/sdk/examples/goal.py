#!/usr/bin/env python3
"""Set a goal and observe automatic rounds through the final model reply."""

from __future__ import annotations

import argparse
import os
import time
from pathlib import Path

from pydantic import BaseModel

from deepseek_harness import CommandExecution, DeepSeekHarness, Notification
from deepseek_harness.api import final_response


class WaitResult(BaseModel):
    """The empty session/wait result."""


def display(notification: Notification) -> dict | None:
    """Print durable assistant output and return the observed root Session event."""
    if notification.method != "session.event":
        return None
    event = notification.payload["event"]
    if event["type"] == "assistant/message":
        text = final_response([event])
        if text:
            print(text, flush=True)
    elif event["type"] == "goal/change":
        print(f"Goal: {event['data']['operation']}", flush=True)
    elif event["type"] == "turn/end" and event["data"]["reason"]["kind"] != "completed":
        raise RuntimeError(f"Goal activity ended: {event['data']['reason']}")
    return event


def main() -> None:
    """Observe goal state before waiting for the final activity interval."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsh-home", required=True, type=Path)
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    parser.add_argument("--model", default=os.environ.get("DSH_MODEL", "deepseek-v4-flash"))
    parser.add_argument("--timeout-seconds", type=float, default=300)
    parser.add_argument("objective", help="Objective for the native /goal command")
    args = parser.parse_args()
    if not args.objective.strip() or args.timeout_seconds <= 0:
        parser.error("objective must be non-blank and timeout-seconds must be positive")
    with DeepSeekHarness(
        dsh_home=str(args.dsh_home.resolve()), cwd=str(args.workspace.resolve()),
        profile="sdk", model=args.model, env={"DSH_PERMISSION_MODE": "workspace-write"},
    ) as harness:
        session = harness.start_session()
        with harness.client.subscribe_notifications(lambda notice: notice.payload.get("sessionId") == session.id) as notifications:
            deadline = time.monotonic() + args.timeout_seconds
            session.query(f"/goal {args.objective}")
            for message in session.receive_response():
                if isinstance(message, CommandExecution):
                    print(message.result.text, flush=True)
                    if message.result.kind == "error":
                        raise RuntimeError(message.result.text)
            while True:
                event = display(notifications.next(timeout_seconds=max(0, deadline - time.monotonic())))
                if event is not None and event["type"] == "goal/change" and event["data"]["operation"] in {
                    "complete", "block", "pause", "clear",
                }:
                    break
            # A terminal goal event can precede the model's closing reply.
            harness.client.request(
                "session/wait", {"sessionId": session.id}, response_model=WaitResult,
                timeout_seconds=max(0, deadline - time.monotonic()),
                on_notification=display, notification_subscription=notifications,
            )


if __name__ == "__main__":
    main()
