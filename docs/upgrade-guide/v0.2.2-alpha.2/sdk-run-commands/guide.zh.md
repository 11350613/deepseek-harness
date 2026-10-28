---
kind: upgrade-guide
description: "SDK run 按定义身份路由原生命令，返回提示词活动或命令结果。"
---

# SDK run 接受原生命令

[English](guide.md) | 中文

## 变更

Python 的 `DeepSeekHarness.run()`、`Session.run()` 及其 TypeScript 对应方法，将字符串与内容块数组发送到同一提示词／命令入口。普通输入返回 `RunResult`，受支持命令返回 `CommandExecution`。命令按官方定义 ID 识别，并以当前注册名执行。中英文别名跟随重命名后的定义，无关的精确同名替换仍作为普通输入。详见[受支持命令规则](../../../../packages/sdk/server/README.zh.md#command-input)。

数组不再绕过原生路由：`run([{"type": "text", "text": "/compact"}])` 会执行压缩。命令携带编码栅格图片时遵循原生附件规则；`/plan off` 携带图片会返回命令错误，且不改变计划状态。命令完成不表示后续计划、审阅或目标轮次已经结束。处理器拒绝仍是命令结果，路由与传输失败会抛出异常或拒绝。

`run("")`、`run([])` 及仅包含空白文本的输入会在创建 Session 或入队前失败，仅图片输入仍被接受。严格命令的身份校验使用已初始化的接收 Agent 目录。身份校验拒绝会保留该 Session，不执行 handler，也不提交 prompt。

## 迁移

1. 在调用 `run()` 前过滤空输入或空白输入。在 Python 读取 `final_response` 或 TypeScript 读取 `finalResponse` 前检查返回类型：使用 `isinstance(result, RunResult)` 或 `'finalResponse' in result`。命令结果包含 `command_id`／`commandId` 及 `result.kind`。
2. 原样排队输入使用 Python `client.session_prompt(session_id, blocks)` 或 TypeScript `client.prompt(sessionId, blocks)`。先订阅，再管理通知及 `session/wait`；这些方法返回回执，而不是 `RunResult`。入队被接受不保证模型接受空输入。运行时技能识别仍适用。
3. 图片输入选择支持图片的模型，沿用 `run([text_block, image_block])`。编码图片包含 `type: "image"`、base64 `data` 和 `mimeType`。匹配到的命令要求一个完整文本块，其余只能是编码图片；额外文本或其他附件会被拒绝，不回退为提示词。图片可放在文本块之前。
4. 自定义 `session/query` 客户端发送 `{ sessionId, contentBlocks, delivery }`，普通提示词的 delivery 为 `queue` 或 `steer`。`session/command` 保留 `{ sessionId, line }`，接受受支持定义的 ASCII 注册名或英文规范别名。中文别名使用 `run()`／`session/query`；名称相同不代表内置定义身份。
5. Python 的 `run()` 和 `session_command()` 收到格式错误的命令响应时抛出 `SdkProtocolError`，并保留校验错误作为 cause。通用 `request(response_model=...)` 保留调用方所选模型的校验行为。
6. 继续使用 `on_notification`／`onNotification` 观察活动。两个命令入口都先发送生命周期通知，再返回响应；转发方必须保序。后续模型工作遵循服务端的命令完成规则。
