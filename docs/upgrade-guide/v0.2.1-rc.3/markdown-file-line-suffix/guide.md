---
kind: upgrade-guide
description: "Markdown file links interpret trailing colon numbers as line locations."
---

# Numeric suffixes in Markdown file links

English | [中文](guide.zh.md)

## Change

Local Markdown destinations ending in `:24`, `:24-30`, or `:24:5` now open the file before that suffix at line 24; columns are ignored. Previously, the suffix was part of the filename. Zero, unsafe integers, reversed ranges, and unsupported fragments now open the file without a line instead of disabling the link. Valid `#L24` fragments retain precedence over colon suffixes. Leading zeros are accepted.

Slash/backslash-rooted paths, including UNC paths, now reach the file opener. Explicit relative and Windows drive paths also take precedence over URLs. Other destinations accepted by the absolute URL parser remain links, including `index.ts:24`, `Makefile:12`, `localhost:3000`, and custom protocols that previously rendered as text. No HTTP scheme is added and no click-time notice is shown. `javascript:`, `vbscript:`, `data:`, and `blob:` remain blocked. See [Markdown navigation](../../../../packages/client/ui-primitives/README.md#rendering-agent-output) for the complete rules.

## Migration

1. When linking a filename such as `notes:24`, encode its literal colon: `[notes](./notes%3A24)`. For a line reference, use `[notes:24](./notes:24)` or `[notes:24](./notes#L24)`.
2. Prefix ambiguous file references with `./`: write `[source](./index.ts:24)`, not `[source](index.ts:24)`. Click the settled link to confirm the intended file and line.
