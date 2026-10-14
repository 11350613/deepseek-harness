# Agent Note: Apply patch file editing

Status: proposed

English | [中文](2026-09-28-apply-patch-file-editing.zh.md)

## Problem

A model editing several files or separated regions needs multiple literal-edit calls or a shell script. Shell and Python edits do not expose their affected paths to the existing file-tool capture path, so a working directory without Git cannot reliably present those edits in the turn Review tab. A patch tool can express related edits in one call and identify every affected path before mutation. Implementation precedes the effectiveness evaluation in #5121; #4556 supplies the broader motivation for efficient use of file tools.

## Proposal

Add an `apply_patch` tool for text-file creation, updates, deletion, and moves, with multiple files and hunks per call. Use Codex patch syntax and the existing filesystem capability, observation policy, sandbox policy, and tool execution lifecycle. Keep parsing and path extraction in a shared pure module so execution and Review capture interpret the same patch.

Review work is limited to collecting the tool's affected paths before mutation and adding necessary composition or configuration entries. Reuse the existing [workspace change recorder](../../../../packages/deliverables/workspace-changes/README.md) and [Review tab](../../../../packages/client/ui-deliverables/README.md), including their diff types and display logic. Moves may appear as deletion plus creation. Rename-specific presentation, durable Review storage, remote capture, and changes to capture limits or failure policy are outside this proposal.

### Confirmed design choices

The choices below are approved. The complete tool remains proposed; the pure parser and text matcher are implemented in [dsh-fs-patch](../../../../packages/fs/fs-patch/README.md), with Codex `rust-v0.158.0` as their syntax and matching reference, and guarded filesystem operations are implemented in [dsh-fs](../../../../packages/fs/fs/README.md) and its providers. The preflight and sequential executor are implemented in [dsh-tool-fs](../../../../packages/fs/tool-fs/README.md). Package READMEs own supported behavior and exclusions; tool registration and presentation remain proposed.

| Topic | Confirmed choice | Implementation specification |
|---|---|---|
| Input | A JSON argument with a `patch` string; reuse filesystem permission fields when applicable. | Final argument schema, activation method, and bounded result fields. |
| Syntax | `*** Begin Patch`, `*** End Patch`, `*** Add File:`, `*** Update File:`, `*** Delete File:`, `*** Move to:`, hunk markers, and `*** End of File`. | Select an upstream Codex version and enumerate supported forms, malformed input, and any exclusions. |
| Matching | Follow the parser and matcher of a pinned Codex version. | Verify the reference behavior for exact matching, whitespace tolerance, Unicode normalization, repeated contexts, search order, empty hunks, and EOF handling; record an expected output or error for each. |
| Filesystem policy | Preserve the mounted observation and sandbox policies; an internal preflight read does not count as a model observation. | Specify update/delete/move guards and destination collisions under these policies, plus path aliases, repeated paths, cross-provider moves, and line-ending preservation. |
| Failure | Preflight the whole patch, then commit in order; stop at the first failure and report actual completed, failed, and unexecuted operations; no whole-patch rollback. | Per-operation commit points, cancellation, and destination-written/source-not-deleted move outcomes. |
| Activation | Enable through composition for implementation and evaluation while retaining existing file tools. | Which profiles expose the tool initially; broader default adoption follows measured results. |

The selected Codex version defines patch syntax and text matching. Read-before-edit, freshness checks, and sandbox restrictions remain Harness deployment policies. The compatibility matrix records these policy differences and the verified reference behavior; it is an implementation specification, not a pending choice between matching strategies.

### Development plan

We implement and verify the steps in order. The parser supplies the shared records for matching, execution, and capture. Steps 1–6 precede integrated acceptance in step 7; evaluation in step 8 follows acceptance.

1. **Implement patch parsing and affected-path collection.** Add `packages/fs/fs-patch` as a pure library without tool, Session, or filesystem-provider dependencies. Pin the Codex syntax reference and retain applicable license notices. Define serializable operations and hunks; implement `parsePatch(patch)` with original-input line errors and `collectMutationPaths(operations)` with both move endpoints. Preserve operation order and repeated operations; deduplicate only collected path strings. Cover single/multiple files and hunks, moves, malformed input, and reference syntax cases without filesystem I/O.

2. **Implement hunk matching and text updates.** Apply the parsed hunks to caller-supplied text in the same pure library. Follow the pinned Codex matcher for exact matching, whitespace tolerance, Unicode normalization, repeated contexts, search order, and EOF behavior. Cover LF/CRLF, missing final newline, empty files, and unmatched hunks; document deliberate differences and expected results. Keep file reads, permission checks, and commits outside this step.

3. **Provide guarded filesystem operations.** The current [filesystem service](../../../../packages/fs/fs/README.md) has text writes and literal edits, but no delete or move operation. Add only the primitives needed by the chosen patch design, preserving provider-owned freshness checks and atomic publication of a single file. Update local, sandboxed, and [SSH filesystem](../../../../packages/ssh/fs-ssh/README.md) implementations and any affected RPC helper/schema consumers together. A move spans two paths: define locking, source and destination guards, and failure outcomes explicitly. Exit when stale versions, denied paths, collisions, and interrupted operations leave the documented disk state; do not claim a multi-file transaction.

4. **Implement patch execution.** Resolve and deduplicate canonical targets, obtain policy intents, and preflight syntax, permissions, matching, and destination rules before mutation. Recheck freshness at each provider commit; preflight does not prevent a later race or I/O failure. Execute in order, update observations after actual mutations, and retain completed-operation facts through cancellation or later failure. Exit when result metadata and concise model output agree with disk state, including partial moves, and the executor never bypasses the filesystem provider with shell or direct host writes.

5. **Expose and present the tool.** Register `apply_patch` through normal plugin effects and the existing tool/PTC paths; keep the agent loop unchanged. Put parameter rules in the schema, teach when to choose the tool, and provide short corrective errors. Design the Host presenter and Web tool-call presentation using existing result metadata and presentation mechanisms. Add the selected activation/configuration entries and fail clearly on missing dependencies. Exit when the intended profiles advertise and execute the tool, disabled profiles remain coherent, and model-visible output is reconstructable from the Session log.

6. **Connect existing Review capture.** The recorder's [mutation-path extraction](../../../../packages/deliverables/workspace-changes/src/capture.ts) currently recognizes a fixed set of tools and returns one path. Add the smallest producer-side adaptation for `apply_patch` to enumerate every affected path, including both move endpoints, from the shared parser. Await baseline capture before any write and retain the first capture of each path in the turn. Reuse turn-end capture and comparison of actual bytes. Exit when a non-Git directory shows every supported file with a net change, repeated edits produce a first-to-last diff, failed/unexecuted operations add no fictitious change, and Review display code is unchanged. This requires a small path-extraction change; configuration alone cannot provide it today.

7. **Verify the composed capability and document it.** Combine focused parser/provider/tool tests with a recorded Session snapshot through a shipped profile and an existing Review flow in a non-Git directory. Cover successful edits, preflight rejection, partial execution, cancellation, and existing-tool regression. If the snapshot harness cannot express a required path, add that support in the same implementation. Update affected bilingual READMEs, JSDoc, subsystem references, and generated catalogs; acknowledge any declared persistence-type changes. Follow [testing policy](../../../../docs/testing.md) and [scope-based checks](../../../skills/dsh-pre-push-checks/SKILL.md). Exit when the acceptance matrix below passes and any unavailable real-provider evidence is explicitly reported.

8. **Evaluate after implementation.** Run the same representative editing tasks with existing file tools and with `apply_patch`, controlling model, repository state, and task instructions. Measure correct final files, task success, request/prompt/output tokens, model steps, tool calls, retries, latency, and existing Review coverage. Report failures as well as gains, including the first-request prompt cost. Exit with a reproducible comparison and a recommendation on default activation; do not assume improvement or build a general benchmarking platform as part of this feature.

### Review acceptance boundary

Review uses whole-file captures before the first mutation and at turn end; tool-call hunks and patch text are not substitutes for these bytes. Test without a Git repository and with Git unavailable so Git coverage cannot conceal missing tool-path capture. A create followed by deletion, or an edit fully reverted in the same turn, has no net change and need not produce a row.

The [existing Review decision](../../implemented/feature/2026-09-15-changed-file-diff-preview.md) owns size/count/time limits, capture-error behavior, session lifetime, and supported locations. This feature inherits them. Acceptance covers supported Host files while their Session is available; it does not promise persistent or SSH Review. Adding operations to the SSH filesystem provider keeps the filesystem API complete and does not imply remote Review support.

## Alternatives considered

**Keep using shell or Python for patches.** This leaves non-Git file changes without a predictable pre-mutation path list and does not provide the requested model-facing editing tool.

**Reuse Codex markers with an independently strict matcher.** This can reduce initial implementation work but makes familiar patches fail differently. The confirmed design follows a pinned Codex parser and matcher, with Harness filesystem-policy differences explicitly recorded.

**Make the whole patch transactional.** Cross-file rollback adds recovery state and can overwrite concurrent external edits. Preflight plus ordered commits gives earlier rejection and explicit partial results without promising rollback.

**Expand Review while adding the tool.** Rename UI, persistent storage, remote capture, and a new capture-failure policy are independent product decisions. Existing capture and diff rendering suffice for the scoped tool integration.

## Acceptance criteria

| Area | Required evidence |
|---|---|
| Text operations | Add, update, delete, move, multiple files, and multiple hunks produce the expected final bytes; syntax and matching differences are recorded. |
| Guarded mutation | Unobserved or stale sources, protected paths, and destination conflicts follow the chosen policies; rejected preflight performs no writes. |
| Failure and cancellation | A failure after an earlier commit reports every completed mutation and every pending operation; disk state and output agree. |
| Non-Git Review | Existing Review shows supported net changes at turn end, including both move endpoints as existing file entries; no display-logic change. |
| Tool experience | Normal calls and PTC use the registered tool; concise output, errors, tool-call presentation, and Session snapshots agree. |
| Adoption evidence | The post-implementation comparison reports correctness and total work before recommending broader activation. |

## Risks

Upstream matching may be permissive or change between versions. Pin the reference and verify its behavior with compatibility fixtures; fix unintended mismatches against that reference. Any proposed matching-policy change must be recorded as a change to the confirmed design. Copying upstream code also requires license and dependency review.

Preflight can succeed before a later version conflict, cancellation, or storage failure. Provider guards and accurate partial outcomes must survive these failures, especially for moves; a test failure here blocks tool acceptance.

Path extraction can drift from execution or omit a move endpoint. Sharing the parsed operations and testing the complete non-Git path is required before enabling the tool in a profile with Review.

This proposal preserves the rationale of the [filesystem split](../../implemented/simplification/2026-06-26-fsspec-style-fs-seam.md), [observation event policy](../../implemented/architecture/2026-06-26-file-context-as-event-gate.md), [filesystem sandbox](../../implemented/feature/2026-07-14-cross-family-fs-sandbox.md), and [turn changed-files card](../../implemented/feature/2026-09-11-turn-changed-files-card.md). It adds an editing capability without superseding those decisions.
