# Agent Note: 默认提供 apply_patch

Status: implemented

[English](2026-10-16-default-apply-patch.md) | 中文

## Problem

单独的启用 overlay 使普通编程会话无法从默认文件系统工具集中使用多文件补丁能力。

## Decision

`tool-fs.enableApplyPatch` 默认为 `true`，与 read、write 和 edit 一同提供。显式设为 `false` 可移除工具及其指导文本。有意排除文本文件工具的最小 SDK 和 Web 预设将其设为 `false`。

本决定取代 [apply_patch 文件编辑](2026-09-28-apply-patch-file-editing.zh.md)中以评测为默认启用前提的决定。提供工具不意味着任务成功率或 token 成本已经改善；受控评测仍独立开展。观察、版本和沙箱要求保持不变。

## Alternatives considered

**继续以评测作为启用前提。** 这会保留默认提供工具所要省去的额外配置。显式关闭开关支持对比评测和不需要该工具的部署。

## Consequences

默认模型请求包含额外的工具 schema 及其指导文本，因此录制请求的预期会变化。已有 write 和 edit 工具继续可用。最小预设保留精简工具集，部署可单独关闭补丁工具而不移除文件系统访问。
