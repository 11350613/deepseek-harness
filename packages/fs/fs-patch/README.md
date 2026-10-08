---
description: "Parse Codex-style file patches into ordered operations and collect affected paths without filesystem I/O."
kind: "package-library"
---

# dsh-fs-patch

English | [中文](README.zh.md)

## Summary

Parse a complete Codex-style patch into ordered file operations with `parsePatch`. Use `collectMutationPaths` to list each source and move destination before capturing file contents. Both functions operate on caller-supplied values without filesystem access. Syntax errors identify the original input line; successful parsing does not authorize or apply a file change.

## Table of Contents

- [Use this package](#use-this-package)
- [Compatibility](#compatibility)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Import the library when execution and file capture need the same interpretation of a patch. Operations and hunks contain only JSON-serializable values. Parsing retains repeated operations in input order; path collection deduplicates exact strings in first-seen order, with the source before a move destination. It does not resolve `a` and `./a` to one target.

```ts
import { collectMutationPaths, parsePatch } from '@deepseek-ai/dsh-fs-patch'

const operations = parsePatch('*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch')
const paths = collectMutationPaths(operations) // ['hello.txt']
```

Malformed input throws `PatchParseError` with a one-based `lineNumber` and a corrective `reason`. Locations count leading blank lines and heredoc wrappers in the original input. No partial operation list is returned on failure.

<a id="compatibility"></a>
## Compatibility

The reference is [OpenAI Codex rust-v0.158.0](https://github.com/openai/codex/tree/rust-v0.158.0/codex-rs/apply-patch/src), specifically `parser.rs` and `streaming_parser.rs`. The [parser tests](tests/parse.spec.ts) adapt selected upstream cases and pin the following supported behavior. The [LICENSE](LICENSE) retains OpenAI attribution and Apache-2.0 terms alongside the MIT license for DeepSeek contributions.

| Input | Parsed result |
|---|---|
| Begin/End Patch; Add/Delete/Update File headers | Ordered operations; an empty patch and an empty added file are accepted. |
| Added file lines prefixed by `+` | Prefix removed; each line contributes a final LF. |
| Update lines prefixed by space, `+`, or `-` | Context, insertion, or deletion; a bare empty line is empty context. |
| First update without `@@`; later `@@` or `@@ text` | Ordered hunks with an optional context anchor; empty hunks are rejected. |
| Move to immediately after Update File | Destination on the update; a move without a nonempty hunk is rejected. |
| End of File after a hunk | EOF flag; following blank lines are ignored and further content requires a new hunk or file header. |
| LF/CRLF, outer Unicode whitespace, indented headers | Codex trimming rules use Unicode `White_Space`, including U+0085 and excluding BOM (U+FEFF). Indented markers inside updates remain context. Content whitespace is retained. |
| Literal `<<EOF`, `<<'EOF'`, or `<<"EOF"` wrappers | Accepted without shell evaluation; the closing line must end in `EOF`, as in the reference. |
| Repeated paths, relative/absolute paths, Unicode text | Retained without path resolution or Unicode normalization. |
| Environment ID header | Explicitly rejected: this library does not select an execution environment. |
| Unified diff, shell commands, malformed markers | Rejected with the original line number; diagnostic wording differs from Codex. |

EOF before any hunk has no effect, matching the reference; an update still requires a nonempty hunk. The reference also accepts a redundant final End Patch after an earlier End Patch and intervening whitespace. Context-line indices distinguish explicit context from equal removed/added text for consumers that match hunks.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The batch parser builds syntax records without a Session or provider dependency. It normalizes patch framing and line endings, then retains file and hunk order. The [syntax types](src/types.ts) carry source locations and explicit context offsets; [path collection](src/index.ts) reads those records without reparsing text. The [filesystem reference](../../../docs/subsystems/filesystem.md#patch-syntax-records) owns the public type definitions.

**Runtime invariant:** No companion is published. This pure library owns no mutable runtime relationship or independent observations that can diverge.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Filesystem package group](../README.md) — providers, policies, and file tools.
- [Apply patch proposal](../../../.agents/notes/proposed/feature/2026-09-28-apply-patch-file-editing.md) — implementation sequence and Review scope.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Text matching and application are not implemented; parsing alone says nothing about whether a hunk matches a file.
- Filesystem mutations, permissions, freshness guards, path safety, tool registration, and Review capture belong to consumers and are not performed here.
- The public API accepts complete strings, not streaming deltas. It exposes no Codex workdir or environment-routing metadata.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
