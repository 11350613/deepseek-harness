---
kind: upgrade-guide
description: "Markdown file links interpret trailing colon numbers as line locations."
---

# Numeric suffixes in Markdown file links

English | [中文](guide.zh.md)

## Change

Local Markdown destinations ending in `:24` or `:24-30` now open the file before that suffix at line 24. Previously, the suffix was part of the filename. Links to files whose names literally end with a colon and numbers need escaping. Destinations with a `#L24` fragment keep their existing interpretation.

## Migration

1. When linking a filename such as `notes:24`, encode its literal colon: `[notes](./notes%3A24)`. For a line reference, use `[notes:24](./notes:24)` or `[notes:24](./notes#L24)`.
2. Click the link in a settled message and confirm the preview opens the intended filename and line.
