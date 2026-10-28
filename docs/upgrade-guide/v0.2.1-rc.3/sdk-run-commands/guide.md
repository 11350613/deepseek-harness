---
kind: upgrade-guide
description: "SDK run routes native commands by definition identity and returns prompt activity or command results."
---

# SDK run accepts native commands

English | [中文](guide.zh.md)

## Change

Python `DeepSeekHarness.run()` and `Session.run()`, and their TypeScript equivalents, route strings and content-block arrays through one prompt-or-command entry. Ordinary input returns `RunResult`; supported commands return `CommandExecution`. Commands are identified by their official definition IDs and execute under their current registered names. English and Chinese aliases follow renamed definitions; an unrelated exact-name replacement remains ordinary input. See the [supported command rules](../../../../packages/sdk/server/README.md#command-input).

Arrays no longer bypass native routing: `run([{"type": "text", "text": "/compact"}])` executes compaction. Commands with encoded raster images follow native attachment rules; `/plan off` with an image returns a command error without changing plan state. Command completion does not mean subsequent planning, review, or goal rounds have finished. Handler refusals remain command results; routing and transport failures raise or reject.

`run("")`, `run([])`, and inputs containing only blank text now fail before Session creation or prompt enqueue. Image-only input remains accepted. Strict command identity checks use the initialized receiving Agent's catalog. Identity rejection retains that Session without executing a handler or submitting a prompt.

## Migration

1. Filter empty or blank input before `run()`. Check the returned type before reading `final_response` in Python or `finalResponse` in TypeScript: use `isinstance(result, RunResult)` or `'finalResponse' in result`. Command results carry `command_id`/`commandId` and `result.kind`.
2. For literal queued input, use Python `client.session_prompt(session_id, blocks)` or TypeScript `client.prompt(sessionId, blocks)`. Subscribe first and manage notifications and `session/wait`; these methods return receipts, not `RunResult`. Enqueue acceptance does not guarantee the model accepts empty input. Runtime skill recognition still applies.
3. For images, select an image-capable model and use the existing `run([text_block, image_block])` form. Encoded images contain `type: "image"`, base64 `data`, and `mimeType`. A matched command requires one complete text block and only encoded images beside it; extra text or other attachments reject without prompt fallback. Images may precede the text block.
4. Custom `session/query` clients send `{ sessionId, contentBlocks, delivery }`; delivery is `queue` or `steer` for ordinary prompts. `session/command` keeps `{ sessionId, line }` and accepts ASCII registered names or canonical English aliases of supported definitions. Chinese aliases use `run()`/`session/query`; a matching name alone does not establish builtin identity.
5. Python malformed command responses from `run()` and `session_command()` raise `SdkProtocolError`, retaining the validation error as their cause. Generic `request(response_model=...)` keeps its caller-selected model validation behavior.
6. Keep `on_notification`/`onNotification` for activity. Both command entry points send lifecycle notifications before their response; forwarding transports must preserve this order. Follow the server's command-completion rules for subsequent model work.
