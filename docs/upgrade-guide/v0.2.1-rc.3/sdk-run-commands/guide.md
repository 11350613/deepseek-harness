---
kind: upgrade-guide
description: "SDK run methods route supported slash-command strings and can return a native command result."
---

# SDK run accepts native commands

English | [中文](guide.zh.md)

## Change

Python `DeepSeekHarness.run()` and `Session.run()`, and their TypeScript equivalents, route non-blank strings through the runtime's ordinary-input and command entry. Supported slash commands execute their native handler. Ordinary text returns `RunResult`; commands return `CommandExecution`. Existing callers that assume every string produces an assistant response must distinguish these results.

Content-block arrays remain literal queued prompts and return `RunResult`. Command completion does not mean that planning, review, or automatic goal rounds have finished. Handler refusals return a command error result; routing and transport failures raise or reject.

## Migration

1. Check the result before reading `final_response` in Python or `finalResponse` in TypeScript. In Python, use `isinstance(result, RunResult)`; in TypeScript, use `'finalResponse' in result`. A command result carries `command_id` in Python or `commandId` in TypeScript, plus `result.kind` and command-owned details.
2. To send slash-prefixed text literally, pass content blocks, for example `session.run([{"type": "text", "text": "/compact"}])`. Use a string when the runtime should recognize commands: `session.run("/compact")`.
3. Keep `on_notification` / `onNotification` for activity notifications. For plan or goal commands that start later work, follow the [SDK command completion rules](../../../../packages/sdk/server/README.md#command-input) before treating the work as finished.
4. Verify that ordinary text still produces the expected `RunResult`, that a supported command returns `CommandExecution`, and that literal content blocks preserve their text.
