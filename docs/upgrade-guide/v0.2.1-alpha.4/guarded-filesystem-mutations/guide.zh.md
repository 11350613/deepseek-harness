---
kind: upgrade-guide
description: "文件系统提供方必须实现受保护的补丁、删除和移动操作，并处理两个新增文件系统错误码。"
---

# 受保护的文件系统补丁、删除和移动操作

[English](guide.md) | 中文

## 变更

下一版本为 `FileSystem` 新增三个抽象方法：`patchText`、`deleteFile` 和 `moveFile`。实现旧 API 的外部子类必须实现这些方法。`FsErrorCode` 新增 `FS_PATCH_MISMATCH` 和 `FS_SAME_TARGET`；穷尽分派的消费方必须处理这两个值。随发行版提供的本地、沙箱和 SSH 提供方均实现这些操作。

`@deepseek-ai/dsh-fs-patch` 提供纯函数 `parsePatch`、`applyHunks` 和 `collectMutationPaths`。SSH helper 新增 `fs.patch`、`fs.delete` 和 `fs.move` RPC 方法。`dsh-tool-fs` 新增默认值为 `true` 的 `enableApplyPatch`；挂载文本工具的 profile 会在已有工具之外提供 `apply_patch` 及其指导文本。最小预设显式关闭它。无需迁移 Session 数据。

## 迁移

1. 按[方法签名和失败保证](../../../../packages/fs/fs/src/index.ts)更新外部 `FileSystem` 子类。保留版本防护、取消、文本处理和沙箱约束。`patchText` 仅在匹配成功后发布完整替换；`deleteFile` 报告被删除的文本；`moveFile` 分别报告目标发布与 `sourceDeleted`。删除源失败时，结果必须保留已发布目标。不要承诺跨路径事务。
2. 在错误码穷尽分派中处理 `FS_PATCH_MISMATCH` 和 `FS_SAME_TARGET`。提供方需要共享语法和 LF 匹配时，使用[纯补丁库](../../../../packages/fs/fs-patch/README.zh.md)。修改调用方从 `fs/edit-intent`、`fs/delete-intent` 或目标的 `fs/write-intent` 获取防护，并记录成功观察；内部读取不能授权修改。
3. 在调用三个新 RPC 方法前，部署版本一致的 SSH Host 和 helper。自定义 helper 必须实现[声明的 helper 协议](../../../../packages/ssh/ssh/src/helper.ts)。
4. 若要省略工具及其指导文本，在 `--patch` overlay 或 `cordis.patch.yml` 的已有 `tool-fs` 行 config 中加入 `enableApplyPatch: false`，保留其他配置字段。遵循[工具配置](../../../../packages/fs/tool-fs/README.zh.md#use-this-package)。编译外部提供方，通过其正常工具组合验证新增、更新、删除、移动、过期版本拒绝和部分删除源失败，并比较最终文件与报告效果。
