---
kind: upgrade-guide
description: "Forge Git 查询使用 Session 权限并禁用已配置的 diff 辅助程序。"
---
# Forge Git 查询权限与内容转换

[English](guide.md) | 中文

## 变更

Forge Git 查询使用 Session 的沙箱模式，不再强制 `read-only`。`danger-full-access` 无需沙箱后端；`workspace-write` 允许在其配置的根目录内写入。受限模式的后端不可用时仍拒绝执行。

本地 diff 与统计仅对每次命令禁用已配置的 clean/process filter。它们比较已存储的 blob 与未经转换的工作区字节，因此已物化的 LFS 文件及其他过滤文件可能显示为变更，即使普通 Git 认为它们未变。不会下载 LFS 对象。子模块提交变化仍可见，但内部未提交修改不显示。

## 迁移

1. 如果 Git 查询需要操作系统强制禁止写入，请将 Session 保持为 `read-only`。通过现有权限选择器选择所需的 Session 模式；配置键没有变化。
2. 对于需要内容转换或检查子模块工作区的仓库，请在所需的 Session 权限下显式运行 Git 命令检查这些变化。面板的本地比较不会应用已配置的转换。
3. 在没有沙箱后端的主机上选择“完全权限”，然后刷新 Forge 面板。检出信息和普通本地变更应可加载；切回受限模式后仍须报告后端不可用。
