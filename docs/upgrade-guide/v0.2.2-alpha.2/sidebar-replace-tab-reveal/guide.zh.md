---
kind: upgrade-guide
description: "右侧 Sidebar 的 `replaceTab` 在揭示时保留发起 tab、在浮窗内原位替换内容，tab 信息同时要求 `panel.isFloating`。"
---

# 右侧 Sidebar 的替换与浮动 tab 上下文

[English](guide.md) | 中文

## 变更

在 `@deepseek-ai/dsh-client-ui-sidebar-right` 中，`replaceTab` 现在只影响新内容落在哪里。此前，带 `replaceTab` 的打开在揭示已展示该内容的 tab 时，也会关闭被替换的 tab；现在被替换的 tab 保持打开。新内容仍然取代被替换 tab 的位置并关闭它。被替换的 tab 浮动时，现在在其浮窗内被原位替换，浮窗保留 pane id 与矩形，且不展开这一列；此前新 tab 在停靠区打开，浮窗关闭。

用 `replaceTab: true` 调用 `tab.actions.openTab` 或 `openResource` 来离开当前 tab 的插件（例如自定义的 `sidebar.right.tab.guide.entry` 卡片）会察觉揭示行为的变化。

`SidebarRightTabInfo.panel` 还要求 `readonly isFloating: boolean`。框架提供的 `useTabInfo()` 会提供该字段，并在 tab 于停靠分栏和浮窗之间移动时更新；`tab.id` 与 `panel.id` 的含义不变。手工构造的 tab 信息（包括 fixture（测试前置数据））必须补充此字段。

## 迁移

1. 若带 `replaceTab` 的打开在内容已打开时也必须移除发起的 tab，就在打开之后调用 `tab.actions.close()`。关闭一个已被这次打开替换的 tab 不会产生任何效果。揭示后再显式关闭可能产生两条历史。随包发布的引导页在 [`GuideBody.tsx`](../../../../packages/client/ui-sidebar-right/src/client/tabs/guide/GuideBody.tsx) 中这样做。
2. 将手工构造的 `SidebarRightTabInfo` 值从 `panel: { id }` 更新为 `panel: { id, isFloating: false }`，用于停靠 fixture；浮动 fixture 则使用 `true`。框架 hook 的消费方无需替换 hook 或查询布局。
3. 重新构建插件。在引导页所在分栏已展示某页时，从自定义引导卡片打开该页，确认该页获得焦点且引导页关闭。将 tab 拖入与拖出浮窗，确认 `isFloating` 切换且 tab id 保持不变。
