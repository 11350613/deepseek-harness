---
kind: upgrade-guide
description: "自定义布局实现与 LayoutController 调用方必须提供框架宽度的 observable。"
---

# 布局实现需提供框架宽度

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-client-ui-layout/client` 中的 `ILayout` 要求提供 `frameWidth: HostObservable<number>`。`LayoutController` 要求将此数据源作为第四个构造参数，放在 `panelInfo` 之后。自定义实现与直接调用构造函数的代码必须提供它；仅使用内置 `ctx.layout` 的插件无需修改。

此数据源报告框架的实测宽度，单位为 CSS 像素，并在宽度变化时通知订阅方。首次测量前，它报告初始窗口宽度。右侧栏的自动全屏呈现与标题栏按钮的占位共用此数据源。

## 迁移

1. 为每个自定义 `ILayout` 实现与测试替身添加 `frameWidth`。从提供框架几何数据的同一布局存储读取宽度，将订阅委托给该存储，并返回其取消订阅函数。
2. 将此数据源作为第四个参数传入每个 `new LayoutController(...)` 调用。不要使用独立的窗口宽度观察器代替它。
3. 运行 TypeScript 检查，再保持右侧栏打开，将框架宽度调整至 768 CSS 像素的两侧。确认侧栏呈现与标题栏按钮同步变化，包括框架与窗口宽度不同的情况。
