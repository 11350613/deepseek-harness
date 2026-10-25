---
kind: upgrade-guide
description: "SDK run 方法会路由已支持的 slash command 字符串，并可能返回原生命令结果。"
---

# SDK run 接受原生命令

[English](guide.md) | 中文

## 变更

Python 的 `DeepSeekHarness.run()`、`Session.run()` 及其 TypeScript 对应方法，会将非空白字符串交给运行时的普通输入与命令入口。已支持的 slash command 执行原生处理器。普通文本返回 `RunResult`，命令返回 `CommandExecution`。假设所有字符串都会产生助手回答的现有调用方，需要区分这两种结果。

内容块数组仍作为原样内容排队输入，并返回 `RunResult`。命令完成不表示计划生成、审阅或自动目标轮次已经结束。处理器拒绝操作时返回命令错误结果；路由和传输失败会抛出异常或拒绝 Promise。

## 迁移

1. 在 Python 中读取 `final_response`、在 TypeScript 中读取 `finalResponse` 前检查结果类型。Python 使用 `isinstance(result, RunResult)`，TypeScript 使用 `'finalResponse' in result`。命令结果在 Python 中携带 `command_id`，在 TypeScript 中携带 `commandId`，并包含 `result.kind` 和命令自身的结果字段。
2. 要原样发送以斜杠开头的文本，传入内容块，例如 `session.run([{"type": "text", "text": "/compact"}])`。需要运行时识别命令时使用字符串：`session.run("/compact")`。
3. 继续使用 `on_notification` / `onNotification` 观察活动通知。对于会启动后续工作的 plan 或 goal 命令，先遵循 [SDK 命令完成规则](../../../../packages/sdk/server/README.zh.md#command-input)，再判断工作是否已经结束。
4. 验证普通文本仍产生预期的 `RunResult`、已支持的命令返回 `CommandExecution`，以及原样内容块保留其文本。
