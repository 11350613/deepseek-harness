#!/usr/bin/env python3
"""Select a full SDK Session's permission preset and continue without resetting it."""

from __future__ import annotations

import argparse
import os
from contextlib import closing
from pathlib import Path

from deepseek_harness import CommandExecution, DeepSeekHarness, RunResult, Session


def receive(session: Session) -> None:
    """Print a command or activity result and stop on a reported failure."""
    with closing(session.receive_response()) as responses:
        for result in responses:
            if isinstance(result, CommandExecution):
                print(f"Command {result.command_id}: {result.result.kind}")
                if result.result.kind == "error":
                    raise RuntimeError(result.result.text)
                if result.result.text is not None:
                    print(result.result.text)
            elif isinstance(result, RunResult):
                if result.finish_reason != "completed":
                    raise RuntimeError(f"Agent turn ended with {result.finish_reason}")
                print(result.final_response)


def main() -> None:
    """Send an explicit permission command, then query the same Session."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsh-home", required=True, type=Path)
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    parser.add_argument("--preset", required=True)
    parser.add_argument("--provider", default="deepseek-official")
    parser.add_argument("--model", default=os.environ.get("DSH_MODEL", "deepseek-v4-flash"))
    args = parser.parse_args()
    if not args.preset.strip():
        parser.error("--preset must be non-blank")

    with DeepSeekHarness(
        dsh_home=str(args.dsh_home.resolve()), cwd=str(args.workspace.resolve()),
        profile="sdk", provider=args.provider, model=args.model,
        env={"DSH_PERMISSION_MODE": "workspace-write"},
    ) as harness:
        session = harness.start_session()
        session.query("Summarize the current file and approval policy in one sentence. Do not use tools.")
        receive(session)
        session.query(f"/permission {args.preset}")
        receive(session)
        print(f"Launch setting: {harness.config.env['DSH_PERMISSION_MODE']}")
        session.query("Summarize the current file and approval policy again. Do not use tools.")
        receive(session)


if __name__ == "__main__":
    main()
