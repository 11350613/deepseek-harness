---
description: "Pointer and keyboard context-menu triggers shared by browser controls and UI primitives."
kind: "package-library"
---

# @deepseek-ai/dsh-util-context-menu

English | [中文](README.zh.md)

## Summary

Browser controls use this library to bind context gestures to an owner-supplied callback. It supplies pointer placement and keyboard handling for React elements. Callers retain the target and menu lifecycle; the library registers no service and owns no shared state.

## Table of Contents

- [Use this package](#use-this-package)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Import `contextMenuTrigger` from `@deepseek-ai/dsh-util-context-menu` and spread `contextMenuTrigger(open)` onto the actual trigger element. The callback receives viewport coordinates in CSS pixels; it captures the business target and opens the owning menu. Pointer context events, Shift+F10, and the ContextMenu key focus that element without scrolling before opening. Handled gestures prevent the native menu and stop propagation; already-prevented events, repeated or composing key events, and unrelated shortcuts remain untouched. Passing `undefined` leaves native behavior intact. Portaled controls bind at their rendered element.

For controls with their own event handlers, `menuPoint(event)` supplies pointer coordinates or the trigger's bottom-left corner when both event coordinates are zero. Programmatic callers can pass their captured target and chosen point directly to [`ctx.menus.open()`](../../client/ui-context-menu/README.md).

The [source](src/index.ts) owns the function signatures. This library imports React types only and can be inlined into browser bundles without sharing runtime identity.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A context event at `(0, 0)` is treated as keyboard-originated. Controls that distinguish a real pointer at the viewport origin must provide their own placement.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
