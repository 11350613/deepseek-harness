---
description: "Add actions to right-click menus without importing a React component"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-context-menu

English | [中文](README.zh.md)

## Summary

Add actions to right-click menus without importing a React component. Targets retain the clicked Session, Workspace, file, directory, URL, image, or pane even when selection changes. Contributions can discover metadata asynchronously and disappear safely when their plugin unloads.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Web application bundle mounts this Client plugin. External Client plugins declare the package in `dsh.client.inject`, import its `/client` types, and inject the `menus` service. `resolutionTimeoutMs` bounds each provider’s preparation (1000ms by default); timed-out providers are aborted and omitted with visible failure feedback.

Ordinary React controls bind `contextMenuTrigger(open)` from ui-primitives to their actual DOM element. The callback supplies an explicit target to `ctx.menus.open()`; no DOM attributes are interpreted as target metadata. Nested controls can prevent handling, and portals bind at their rendered element. Special editors and canvases can call `open()` directly.

### Register actions

Call `ctx.effect(() => ctx.menus.register({ id, target, order, resolve }))` in the contributing plugin. `resolve` receives the captured target and its cancellation signal; return localized actions with stable IDs, optional icons, disabled state, submenus, and execution callbacks. Contributions sort by `order`, then ID. Duplicate contribution IDs within one target family fail registration; duplicate action paths reject that provider’s result. IDs are encoded by segment before publication.

An action’s optional `commandId` associates it with an existing shortcut command. The overlay subscribes to `ctx.shortcuts.catalog`, including configured, removed, and reset bindings; nested and footer actions use the same presentation. This association never dispatches the command: selection invokes only the action’s captured `run` callback. The menu plugin requires the `shortcuts` service.

A contribution can declare `observe(target)` sources for permissions, membership, or localized labels. Source updates re-resolve that contribution against the same captured target and replace its callbacks; outdated asynchronous preparations are cancelled. Dismissal and plugin unload release every subscription.

Extend `MenuTargetMap` through declaration merging on `@deepseek-ai/dsh-client-ui-context-menu/client` for a new target family, then open it with `ctx.menus.open({ kind, value }, { x, y })`. Keep target values as immutable JSON-compatible identifiers and metadata. Execution callbacks capture that value; they must recheck mutable resources before acting. New registrations participate in the next opening. Unregistering removes visible actions and cancels pending metadata.

`ctx.menus.resolve(target)` gives a separate occurrence for another renderer. Subscribe to its immutable action views, select a published ID, and dispose it when its owner closes. Views contain presentation fields only. Callbacks remain in the registry and execute at most once. Dismissal and replacement cancel metadata, but an action already selected owns its own execution and cancellation. Rejected providers and actions produce a persistent overlay toast; an action’s localized `failureLabel` supplies operation-specific recovery guidance.

Shared popups wait for every contribution to settle or time out before appearing. A repeated gesture within four CSS pixels closes the same target; a farther gesture replaces it with a separate fade. `ready` gives custom renderers the same preparation point. Actions pass `icon?: ReactNode` directly to the shared Menu. Contributing plugins create glyph elements or an `<img>` for application icons; icons are neither serialized nor mapped by the registry. Structured action icons align within each divider group; component contributions retain their own layout. Normal dismissal retains the popup for 80ms, replacement for 10ms; opening waits at least 20ms and fades in over 40ms. Reduced motion suppresses the fade.

The optional keyed `contextMenu.content` Slot hosts component contributions. Existing Session and tab Slot names remain owned by their feature adapters. Keyboard context keys and Shift+F10 use the focused trigger’s lower edge. `afterContent` places a data action after those rows; ordinary actions render before them.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The registry separates resolution and callback lifetimes from presentation. The shared overlay uses the existing Menu primitive for keyboard movement, focus return, dismissal, submenus, and viewport positioning. [Registry](src/client/registry.ts) owns cancellation and ordering; [target and action types](src/client/types.ts) own the public fields.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Slots](../ui-slots/README.md) — component contributions.
- [File actions](../ui-file-actions/README.md) — original content transfer.
- [Open in app](../ui-open-in-app/README.md) — shipped resource actions.

-----

<a id="model-experience"></a>
## Model Experience

None, as popup presentation and registration do not construct model input.

#### KV Cache effect

None; contributed feature actions own any subsequent model interaction.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The shipped renderer is the shared Web Menu, including inside Desktop. Native menu rendering is not supplied.
- Component-only legacy actions do not appear in the plain-data resolution API.
- Menus are window-local and transient; they are not persisted in Session data.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
