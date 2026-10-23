---
kind: upgrade-guide
description: "Markdown 文件链接将末尾的冒号数字解释为行号定位。"
---

# Markdown 文件链接中的数字后缀

[English](guide.md) | 中文

## 变更

以 `:24`、`:24-30` 或 `:24:5` 结尾的本地 Markdown 目标现在会打开后缀之前的文件并定位到第 24 行；列号被忽略。此前，后缀属于文件名。零、超出安全整数范围的值、倒序范围及不支持的片段现在只打开文件，不指定行号，不再禁用链接。有效的 `#L24` 片段仍优先于冒号后缀。接受前导零。

斜杠或反斜杠开头的路径（包括 UNC 路径）现在会传给文件打开器。明确的相对路径和 Windows 盘符路径也优先于 URL。其余能被绝对 URL 解析器接受的目标保留为链接，包括 `index.ts:24`、`Makefile:12`、`localhost:3000` 和此前显示为文本的自定义协议。不补 HTTP 协议，也不添加点击后的提示。`javascript:`、`vbscript:`、`data:` 和 `blob:` 仍被禁止。完整规则见 [Markdown 导航](../../../../packages/client/ui-primitives/README.zh.md#rendering-agent-output)。

## 迁移

1. 链接到 `notes:24` 这样的文件名时，将字面冒号编码：`[notes](./notes%3A24)`。引用行号时，使用 `[notes:24](./notes:24)` 或 `[notes:24](./notes#L24)`。
2. 为有歧义的文件引用添加 `./`：使用 `[source](./index.ts:24)`，而不是 `[source](index.ts:24)`。在消息落定后点击链接，确认预期的文件和行号。
