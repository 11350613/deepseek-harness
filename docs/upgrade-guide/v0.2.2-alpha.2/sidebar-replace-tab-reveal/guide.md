---
kind: upgrade-guide
description: "Right-Sidebar `replaceTab` preserves the initiating tab on reveal and replaces floating content in place, while tab information requires `panel.isFloating`."
---

# Right-Sidebar replacement and floating tab context

English | [中文](guide.zh.md)

## Change

In `@deepseek-ai/dsh-client-ui-sidebar-right`, `replaceTab` now affects only where new content lands. Previously an open with `replaceTab` that revealed a tab already showing the content also closed the replaced tab; now the replaced tab stays open. New content still takes the replaced tab's place and closes it. A floating replaced tab is now replaced inside its floating panel, which keeps its pane id and rectangle and does not expand the column; previously the new tab opened in the docked area and the floating panel closed.

Plugins that call `tab.actions.openTab` or `openResource` with `replaceTab: true` to leave a tab, such as a custom `sidebar.right.tab.guide.entry` card, observe the reveal change.

`SidebarRightTabInfo.panel` also requires `readonly isFloating: boolean`. Framework-provided `useTabInfo()` supplies it and updates it when the tab moves between docked and floating panes; `tab.id` and `panel.id` retain their meanings. Hand-built tab information, including test fixtures, must supply the new field.

## Migration

1. Where an open with `replaceTab` must remove the initiating tab even when the content is already open, call `tab.actions.close()` after the open. Closing a tab that the open already replaced does nothing. A reveal followed by this explicit close can produce two history entries. The shipped guide does this in [`GuideBody.tsx`](../../../../packages/client/ui-sidebar-right/src/client/tabs/guide/GuideBody.tsx).
2. Update manually constructed `SidebarRightTabInfo` values from `panel: { id }` to `panel: { id, isFloating: false }` for docked fixtures, or `true` for floating fixtures. Consumers of the framework hook need no replacement hook or layout query.
3. Rebuild the plugin. Open a page from a custom guide card while the guide's pane already shows that page, and confirm that the page is focused and the guide closes. Drag a tab into and out of a floating panel and confirm that `isFloating` switches while its tab id stays the same.
