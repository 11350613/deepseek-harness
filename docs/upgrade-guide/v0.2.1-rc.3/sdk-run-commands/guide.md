---
kind: upgrade-guide
description: "SDK run methods route supported slash commands in strings and content-block arrays and can return a native command result."
---

# SDK run accepts native commands

English | [中文](guide.zh.md)

## Change

Python `DeepSeekHarness.run()` and `Session.run()`, and their TypeScript equivalents, route strings and content-block arrays through one ordinary-input and command entry. Supported slash commands execute their native handler. Ordinary input returns `RunResult`; commands return `CommandExecution`. Both input forms support queue or steer delivery for ordinary prompts. Callers that assume every run returns an assistant response must distinguish these results.

Content-block arrays no longer bypass native slash-command routing. For example, `run([{"type": "text", "text": "/compact"}])` executes compaction. Arrays containing command text and encoded raster images follow Desktop's native attachment rules; `/plan off` with an image returns a command error without changing plan state. Command completion does not mean planning, review, or automatic goal rounds have finished. Handler refusals return a command error result; routing and transport failures raise or reject.

## Migration

1. Check the result before reading `final_response` in Python or `finalResponse` in TypeScript. In Python, use `isinstance(result, RunResult)`; in TypeScript, use `'finalResponse' in result`. A command result carries `command_id` in Python or `commandId` in TypeScript, plus `result.kind` and command-owned details.
2. To bypass native command routing, move the blocks to Python `client.session_prompt(session_id, blocks)` or TypeScript `client.prompt(sessionId, blocks)`. Subscribe before sending and manage subsequent notifications and `session/wait` yourself; these methods return an enqueue receipt, not `RunResult`. Runtime skill recognition still applies.
3. Select a model that supports image input. Submit command text and images together through `run([text_block, image_block])`; an encoded image contains `type: "image"`, base64 `data`, and `mimeType`. Place the complete command in the first text block; a recognized command rejects extra text blocks or non-encoded-image blocks instead of falling back to a prompt. Images may precede the text block. No additional input option is required.
4. Custom `session/query` clients must send `{ sessionId, contentBlocks, delivery }`; convert text into a `{ type: "text", text }` block. The text-only `session/command` and queued `session/prompt` methods retain their request fields.
5. Keep `on_notification` / `onNotification` for activity notifications. Follow the [SDK command completion rules](../../../../packages/sdk/server/README.md#command-input) for subsequent plan or goal work. Verify equivalent routing for strings and arrays, ordinary prompt delivery, `/plan off` image rejection, and low-level prompt bypass.
