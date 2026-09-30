---
description: "将 Codex 风格的文件补丁解析为有序操作并收集受影响路径，不执行文件系统 I/O。"
kind: "package-library"
---

# dsh-fs-patch

[English](README.md) | 中文

## 概述

使用 `parsePatch` 将完整的 Codex 风格补丁解析为有序文件操作。使用 `collectMutationPaths` 在采集文件内容前列出每个源路径和移动目标路径。两个函数都只处理调用方传入的值，不访问文件系统。语法错误标明原始输入行号；解析成功不代表文件修改已获授权或已被执行。

## 目录

- [使用此包](#use-this-package)
- [兼容性](#compatibility)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

执行与文件采集需要以相同规则解释补丁时，导入此库。操作和 hunk（修改块）只包含可 JSON 序列化的值。解析保留重复操作及其输入顺序；路径收集按首次出现顺序对原字符串去重，移动时先列源路径再列目标路径。它不会将 `a` 和 `./a` 解析为同一目标。

```ts
import { collectMutationPaths, parsePatch } from '@deepseek-ai/dsh-fs-patch'

const operations = parsePatch('*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch')
const paths = collectMutationPaths(operations) // ['hello.txt']
```

非法输入抛出 `PatchParseError`，包含从 1 开始的 `lineNumber` 和说明如何修正的 `reason`。位置计入原始输入中的前导空行和 heredoc 包装。失败时不会返回部分操作列表。

<a id="compatibility"></a>
## 兼容性

参照实现为 [OpenAI Codex rust-v0.158.0](https://github.com/openai/codex/tree/rust-v0.158.0/codex-rs/apply-patch/src) 中的 `parser.rs` 和 `streaming_parser.rs`。[解析器测试](tests/parse.spec.ts) 改编了选定的上游用例，并固定以下支持行为。[LICENSE](LICENSE) 在 DeepSeek 贡献的 MIT 许可证之外，保留 OpenAI 署名与 Apache-2.0 条款。

| 输入 | 解析结果 |
|---|---|
| Begin/End Patch；Add/Delete/Update File 头 | 有序操作；接受空补丁和空新增文件。 |
| 新增文件中以 `+` 为前缀的行 | 去除前缀；每行都附带末尾 LF。 |
| 更新中以空格、`+` 或 `-` 为前缀的行 | 上下文、插入或删除；没有前缀的空行视为空上下文。 |
| 首个更新省略 `@@`；后续使用 `@@` 或 `@@ text` | 带可选上下文锚点的有序 hunk；拒绝空 hunk。 |
| 紧跟 Update File 的 Move to | 更新操作携带目标路径；没有非空 hunk 的移动被拒绝。 |
| hunk 后的 End of File | 设置 EOF 标志；忽略后续空白行，更多内容需要新的 hunk 或文件头。 |
| LF/CRLF、外围 Unicode 空白、缩进的文件头 | 遵循 Codex 裁剪规则；更新内部缩进的标记仍作为上下文。保留内容空白。 |
| 字面量 `<<EOF`、`<<'EOF'` 或 `<<"EOF"` 包装 | 接受但不执行 shell；与参照实现相同，结束行必须以 `EOF` 结尾。 |
| 重复路径、相对/绝对路径、Unicode 文本 | 原样保留，不解析路径或进行 Unicode 归一化。 |
| Environment ID 头 | 明确拒绝：此库不选择执行环境。 |
| Unified diff、shell 命令、非法标记 | 拒绝并给出原始行号；诊断措辞与 Codex 不同。 |

与参照实现相同，任何 hunk 之前的 EOF 没有效果；更新仍然需要非空 hunk。参照实现也接受在较早的 End Patch 和中间空白之后重复出现的最终 End Patch。上下文行索引区分显式上下文与内容相同的删除/新增行，供匹配 hunk 的消费方使用。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

批量解析器构建语法记录，不依赖 Session 或提供方。它规范化补丁起止标记和换行符，再保留文件及 hunk 的顺序。[语法类型](src/types.ts) 携带源位置和显式上下文偏移；[路径收集](src/index.ts) 读取这些记录，不重新解析文本。[文件系统参考](../../../docs/subsystems/filesystem.zh.md#patch-syntax-records) 维护公开类型定义。

**运行时不变量：** 不发布 companion。此纯库不拥有可变运行时关系或可能发生偏离的独立观测。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [文件系统包组](../README.zh.md)——提供方、策略和文件工具。
- [Apply patch 提案](../../../.agents/notes/proposed/feature/2026-09-28-apply-patch-file-editing.zh.md)——实现顺序与 Review 范围。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 尚未实现文本匹配与应用；仅解析成功不能说明 hunk 能否匹配文件。
- 文件系统修改、权限、新鲜度保护、路径安全、工具注册和 Review 采集由消费方负责，此库不执行这些操作。
- 公开 API 接受完整字符串，不接收流式增量。不暴露 Codex workdir 或环境路由元数据。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
