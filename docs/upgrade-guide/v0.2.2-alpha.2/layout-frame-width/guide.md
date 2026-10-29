---
kind: upgrade-guide
description: "Custom layout implementations and LayoutController callers must provide the frame-width observable."
---

# Layout implementations provide frame width

English | [中文](guide.zh.md)

## Change

`ILayout` from `@deepseek-ai/dsh-client-ui-layout/client` requires `frameWidth: HostObservable<number>`. `LayoutController` requires this source as its fourth constructor argument, after `panelInfo`. Custom implementations and direct constructor callers must supply it; plugins that only consume the shipped `ctx.layout` need no changes.

The source reports the frame's measured width in CSS pixels and notifies subscribers when it changes. Before the first measurement, it reports the initial window width. The right sidebar uses this source for both its automatic fullscreen presentation and its header button's retained space.

## Migration

1. Add `frameWidth` to each custom `ILayout` implementation and test fake. Read from the same layout storage that supplies the frame's geometry; delegate subscriptions to that storage and return its unsubscribe function.
2. Pass that source as the fourth argument to each `new LayoutController(...)` call. Do not replace it with an independent window-width observer.
3. Run your TypeScript checks, then resize the frame across 768 CSS pixels with the right sidebar open. Confirm that the sidebar presentation and header button change together, including when frame and window widths differ.
