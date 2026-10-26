---
kind: upgrade-guide
description: "SDK run 方法会路由字符串和内容块数组中的已支持 slash command，并可能返回原生命令结果。"
---

# SDK run 接受原生命令

[English](guide.md) | 中文

## 变更

Python 的 `DeepSeekHarness.run()`、`Session.run()` 及其 TypeScript 对应方法，会将字符串和内容块数组交给同一个普通输入与命令入口。已支持的 slash command 执行原生处理器。普通输入返回 `RunResult`，命令返回 `CommandExecution`。两种输入形式的普通提示词都支持 queue 或 steer 投递。假设所有 run 都返回助手回答的调用方，需要区分这两种结果。

内容块数组不再绕过原生 slash command 路由。例如，`run([{"type": "text", "text": "/compact"}])` 会执行压缩。包含命令文本和编码栅格图片的数组遵循 Desktop 的原生附件规则；`/plan off` 携图返回命令错误，不修改计划状态。命令完成不表示计划生成、审阅或自动目标轮次已经结束。处理器拒绝操作时返回命令错误结果；路由和传输失败会抛出异常或拒绝 Promise。

`run("")`、`run([])` 和仅包含空白文本的输入，原先会进入提示词队列。现在这些输入会在创建 Session 或提示词入队前，以 JSON-RPC 错误拒绝。仅图片输入仍然接受。

## 迁移

1. 调用 `run()` 前过滤空白字符串、空数组和仅包含空白文本的数组。如果确实需要原始排队输入，使用下述低层 prompt 方法；入队成功不保证模型接受空输入。
2. 在 Python 中读取 `final_response`、在 TypeScript 中读取 `finalResponse` 前检查结果类型。Python 使用 `isinstance(result, RunResult)`，TypeScript 使用 `'finalResponse' in result`。命令结果在 Python 中携带 `command_id`，在 TypeScript 中携带 `commandId`，并包含 `result.kind` 和命令自身的结果字段。
3. 要绕过原生命令路由，将内容块改为传入 Python `client.session_prompt(session_id, blocks)` 或 TypeScript `client.prompt(sessionId, blocks)`。发送前先订阅，自行管理后续通知与 `session/wait`；这些方法返回入队回执，而非 `RunResult`。运行时 skill（技能）识别仍然适用。
4. 先选择支持图片输入的模型。通过 `run([text_block, image_block])` 同时提交命令文本和图片；编码图片包含 `type: "image"`、base64 `data` 和 `mimeType`。将完整命令放在第一个文本块中；已识别命令会拒绝额外文本块或非编码图片块，不回退为普通提示词。图片可位于文本块前。不需要额外的输入选项。
5. 自定义 `session/query` 客户端必须发送 `{ sessionId, contentBlocks, delivery }`；将文本转换为 `{ type: "text", text }` 块。仅接受文本的 `session/command` 和排队输入的 `session/prompt` 保留原有请求字段。
6. 继续使用 `on_notification` / `onNotification` 观察活动通知。plan 或 goal 的后续工作遵循 [SDK 命令完成规则](../../../../packages/sdk/server/README.zh.md#command-input)。验证字符串和数组路由一致、普通提示词投递、`/plan off` 携图拒绝，以及低层 prompt 绕过行为。
