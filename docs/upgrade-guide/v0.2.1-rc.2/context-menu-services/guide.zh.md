---
kind: upgrade-guide
description: "自定义 Client 组合必须提供 GUI 插件所需的右键菜单与文件动作服务。"
---

# 自定义 Client 组合中的右键菜单服务

[English](guide.md) | 中文

## 变更

GUI 插件现在注入 `menus` 以打开共享对象菜单。open-in-app 插件还注入 `fileActions`、`sidebarRight`、`sidebarRightTabs` 和 `remote.workspaceFiles`。自定义组合若挂载这些 GUI 插件却没有新服务，将无法激活它们。随附 Web 应用 bundle（插件包）已包含提供方；现有 Session 和标签页菜单 Slot 名称仍可使用。

## 迁移

1. 在自定义组合所属的包清单中，添加与 Harness 版本一致的 `@deepseek-ai/dsh-client-ui-context-menu` 和 `@deepseek-ai/dsh-client-ui-file-actions` 依赖。
2. 在自定义 Client 组合中将两个包名添加为插件行，与已有 locale、slots、侧栏和工作区文件提供方并列。默认 `@deepseek-ai/dsh-web-app` bundle 已包含这些行。
3. 按变更后的公开注入类型更新自定义 UI 适配器，包括 `WorkspaceBrowserInjected.openSessionMenu` 及其 `menuTarget` hook、`ChatViewInjected.openContextMenu`，以及文档和文件行的菜单回调。在插件中绑定 `menus` 服务，并将声明的回调传给组件。外部动作注册参见[菜单参考](../../../../packages/client/ui-context-menu/README.zh.md)。
4. 重新构建并启动自定义 profile（配置档）。确认 GUI 插件正常激活、右键后台 Session 不改变选择，且现有 Session/标签页 Slot 贡献仍然显示。
