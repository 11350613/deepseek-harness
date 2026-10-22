#!/usr/bin/env python3
"""Compact a full SDK Session and continue with its retained context."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from deepseek_harness import CommandExecution, DeepSeekHarness, RunResult, Session


def receive(session: Session) -> None:
    """Consume notifications and print the query's command or activity result."""
    for result in session.receive_response():
        if isinstance(result, RunResult):
            if result.finish_reason != "completed":
                raise RuntimeError(f"Agent turn ended with {result.finish_reason}: {result.final_response}")
            print(result.final_response)
        elif isinstance(result, CommandExecution):
            print(f"Command {result.command_id}: {result.result.kind}")
            if result.result.kind == "error":
                raise RuntimeError(result.result.text)
            if result.result.text is not None:
                print(result.result.text)


def main() -> None:
    """Create conversation history, compact it, and ask a follow-up question."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsh-home", required=True, type=Path)
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    parser.add_argument("--session-id")
    parser.add_argument("--provider", default="deepseek-official")
    parser.add_argument("--model", default=os.environ.get("DSH_MODEL", "deepseek-v4-flash"))
    parser.add_argument("--max-tokens", type=int)
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    readme = workspace / "README.md"
    if not readme.is_file():
        parser.error("--workspace must contain README.md to provide conversation history")

    with DeepSeekHarness(
        dsh_home=str(args.dsh_home.resolve()),
        cwd=str(workspace),
        profile="sdk",
        provider=args.provider,
        model=args.model,
        max_tokens=args.max_tokens,
    ) as harness:
        session = harness.start_session(args.session_id)
        session.query(
            "Read this project README and summarize its purpose and development commands without using tools.\n\n"
            + readme.read_text(encoding="utf-8")
        )
        receive(session)
        session.query("/compact")
        receive(session)
        session.query("What are the project's purpose and development commands? Use the earlier README without tools.")
        receive(session)


if __name__ == "__main__":
    main()
