---
description: "Parse Codex-style patches, apply hunks to text, and collect affected paths without filesystem I/O."
kind: "package-library"
---

# dsh-fs-patch

English | [中文](README.zh.md)

## Summary

Parse a complete Codex-style patch into ordered file operations with `parsePatch`, then apply update hunks to LF-normalized text with `applyHunks`. Use `collectMutationPaths` to list each source and move destination before capturing file contents. These functions use caller-supplied values without filesystem access. Syntax errors throw with the original input line; matching returns new text or a structured failure. Neither operation authorizes or commits a file change.

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
import { applyHunks, collectMutationPaths, parsePatch } from '@deepseek-ai/dsh-fs-patch'

const operations = parsePatch('*** Begin Patch\n*** Update File: hello.txt\n-hello\n+hi\n*** End Patch')
const paths = collectMutationPaths(operations) // ['hello.txt']
const operation = operations[0]
if (operation?.kind === 'update') {
  const result = applyHunks('hello\n', operation.hunks) // { ok: true, after: 'hi\n' }
}
```

Malformed input throws `PatchParseError` with a one-based `lineNumber` and a corrective `reason`. Locations count leading blank lines and heredoc wrappers in the original input. No partial operation list is returned on failure.

`applyHunks` returns `{ ok: true, after }` or `{ ok: false, failure }` without mutating its inputs. A match failure reports the hunk's patch line, `context` or `oldLines` stage, sequential search cursor, and original unmatched pattern. The cursor is the `start` argument; EOF matching overrides it with the tail candidate. A trailing-empty-line retry still reports the original pattern. Failure contains no partial text and does not throw, allowing callers to collect preflight failures across file operations. All result fields are JSON-serializable.

<a id="compatibility"></a>
## Compatibility

The reference is [OpenAI Codex rust-v0.158.0](https://github.com/openai/codex/tree/rust-v0.158.0/codex-rs/apply-patch/src): `parser.rs` and `streaming_parser.rs` for syntax, and `seek_sequence.rs` and `file_update.rs` for matching and `NormalizeToLf` reconstruction. `text_file.rs` documents the separate line-preserving representation. The [parser tests](tests/parse.spec.ts) and [text tests](tests/apply.spec.ts) adapt selected upstream cases, including `file_update_tests.rs` and `lib.rs`. The [LICENSE](LICENSE) retains OpenAI attribution and Apache-2.0 terms alongside the MIT license for DeepSeek contributions.

### Parsing

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
| Environment ID header | Dedicated unsupported-header error before the first operation; ordinary syntax errors elsewhere. This library does not select an execution environment. |
| Unified diff, shell commands, malformed markers | Rejected with the original line number; diagnostic wording differs from Codex. |

EOF before any hunk has no effect, matching the reference; an update still requires a nonempty hunk. The reference also accepts a redundant final End Patch after an earlier End Patch and intervening whitespace. Context-line indices distinguish explicit context from equal removed/added text.

### Matching and text updates

| Input or rule | Result |
|---|---|
| Four matching passes | Exact, trailing `White_Space` trimmed on both sides, both ends trimmed, then trimmed Unicode punctuation mapped to ASCII. Each pass searches all candidates before the next pass. |
| Unicode punctuation | U+2010–2015 and U+2212 map to `-`; U+2018–201B to single quotes; U+201C–201F to double quotes; U+00A0, U+2002–200A, U+202F, U+205F, and U+3000 to space. No NFC/NFKC normalization. |
| `@@ text` and repeated content | Find the first matching anchor from the cursor, then search after it. Old lines use the first match from that cursor, which advances to the match end. All searches use the original text. |
| EOF hunk | Search only at `lineCount - patternLength`, even before the cursor. The pinned implementation does not fall back to earlier matches, despite its search-function comment. |
| Empty old lines | Insert at the original file's end, before its final empty source line when present. The insertion does not advance the cursor; an anchor must still match. Same-position insertions retain patch order. |
| Unmatched pattern ending in an empty line | Retry without that last line; also remove the last new line if it is empty. An empty retry pattern matches the cursor. |
| Reconstruction | Remove one terminal empty split element before matching; apply stably sorted replacements in reverse order. Add a terminal empty element unless one exists, then join with LF. Empty output stays empty; nonempty output ends in LF. |
| Context lines | Replace the complete matched region from patch text, including tolerated context differences. `contextLineIndices` is unused: upstream only uses it in `PreserveLineEndings`. |
| No hunks | Still perform the same reconstruction, so a missing terminal LF is added and one terminal empty line can be consumed. |

The intentional differences from Codex are ownership and result reporting: line-ending style is preserved by the DSH provider, while the matcher only sees LF-normalized text; `PreserveLineEndings` is not implemented. CR is an ordinary character, not a separator: untouched CRLF can survive, while trailing-whitespace matching can consume CR in a replaced line. Callers must normalize CRLF first and restore the chosen style afterward. Match failures return structured data rather than Codex's path-bearing errors; the caller owns file identification and user-facing diagnostics. Syntax errors still throw `PatchParseError` before matching.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The batch parser builds syntax records without a Session or provider dependency. The [text updater](src/apply.ts) locates hunks against the original text before constructing a complete result. The [types](src/types.ts) carry syntax locations and match failures; [path collection](src/index.ts) reads syntax records without reparsing text. The [filesystem reference](../../../docs/subsystems/filesystem.md#patch-syntax-records) owns the public type definitions.

**Runtime invariant:** No companion is published. This pure library owns no mutable runtime relationship or independent observations that can diverge.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Filesystem package group](../README.md) — providers, policies, and file tools.
- [Apply patch proposal](../../../.agents/notes/implemented/feature/2026-09-28-apply-patch-file-editing.md) — implementation sequence and Review scope.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Text updates implement only `NormalizeToLf`; callers own line-ending conversion. Parsing alone says nothing about whether a hunk matches a file.
- [dsh-fs](../fs/README.md) provides guarded `patchText`, `deleteFile`, and `moveFile`; providers own permissions, freshness, path safety, and line-ending conversion. Tool registration and Review capture belong to consumers.
- The public API accepts complete strings, not streaming deltas. It exposes no Codex workdir or environment-routing metadata.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
