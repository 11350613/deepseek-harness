---
description: "浏览器控件与 UI 基础组件共用的鼠标和键盘右键菜单触发工具。"
kind: "package-library"
---

# @deepseek-ai/dsh-util-context-menu

[English](README.md) | 中文

## 概述

浏览器控件通过本库将右键手势绑定到调用方提供的回调。本库为 React 元素提供鼠标定位和键盘处理。目标及菜单生命周期由调用方持有；本库不注册服务，也不持有共享状态。

## 目录

- [使用本包](#use-this-package)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

从 `@deepseek-ai/dsh-util-context-menu` 导入 `contextMenuTrigger`，将 `contextMenuTrigger(open)` 展开到实际触发元素上。回调接收以 CSS 像素为单位的视口坐标；它捕获业务目标并打开所属菜单。鼠标右键事件、Shift+F10 和 ContextMenu 键会先聚焦该元素且不滚动，再打开菜单。已处理的手势阻止原生菜单并停止冒泡；已被阻止的事件、重复或正在输入法组合中的键盘事件及无关快捷键保持原状。传入 `undefined` 保留原生行为。Portal 内的控件在实际渲染元素上绑定。

已有独立事件处理器的控件可以用 `menuPoint(event)` 获取鼠标坐标；事件的两个坐标都为零时，返回触发元素的左下角。程序调用方可将捕获的目标和选定坐标直接传给 [`ctx.menus.open()`](../../client/ui-context-menu/README.zh.md)。

[源码](src/index.ts) 定义函数签名。本库仅导入 React 类型，可内联到浏览器产物中，无需共享运行时身份。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 坐标为 `(0, 0)` 的右键事件视为键盘触发。需要区分视口原点处真实鼠标事件的控件应自行提供定位。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文</summary>

无。

</details>
