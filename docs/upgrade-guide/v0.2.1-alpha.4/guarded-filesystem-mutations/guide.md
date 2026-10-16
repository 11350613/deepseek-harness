---
kind: upgrade-guide
description: "Filesystem providers must implement guarded patch, delete, and move operations and handle two new filesystem error codes."
---

# Guarded filesystem patch, delete, and move operations

English | [中文](guide.zh.md)

## Change

The next release adds three abstract methods to `FileSystem`: `patchText`, `deleteFile`, and `moveFile`. External subclasses that implemented the earlier API must implement them. `FsErrorCode` adds `FS_PATCH_MISMATCH` and `FS_SAME_TARGET`; exhaustive consumers must handle both. The bundled local, sandboxed, and SSH providers implement these operations.

`@deepseek-ai/dsh-fs-patch` provides pure `parsePatch`, `applyHunks`, and `collectMutationPaths` functions. The SSH helper adds `fs.patch`, `fs.delete`, and `fs.move` RPC methods. `dsh-tool-fs` adds `enableApplyPatch`, defaulting to `false`; existing profiles keep their current tools until explicitly enabled. No Session-data migration is required.

## Migration

1. Update external `FileSystem` subclasses to the [method signatures and failure guarantees](../../../../packages/fs/fs/src/index.ts). Preserve version guards, cancellation, text handling, and sandbox enforcement. `patchText` publishes a complete replacement only after matching succeeds; `deleteFile` reports the removed text; `moveFile` reports destination publication and `sourceDeleted` separately. A failed source deletion must retain the published destination in its result. Do not promise a transaction across paths.
2. Handle `FS_PATCH_MISMATCH` and `FS_SAME_TARGET` in exhaustive error-code dispatch. Use [the pure patch library](../../../../packages/fs/fs-patch/README.md) if the provider needs shared syntax and LF matching. Mutation callers obtain guards from `fs/edit-intent`, `fs/delete-intent`, or destination `fs/write-intent`, and record successful observations; internal reads do not authorize mutations.
3. Deploy the SSH host and helper from matching package versions before invoking the three new RPC methods. Custom helpers must implement the [declared helper protocol](../../../../packages/ssh/ssh/src/helper.ts).
4. To evaluate the tool, add `enableApplyPatch: true` to the existing `tool-fs` row's config in a `--patch` overlay or `cordis.patch.yml`, preserving other configured fields. Follow [tool configuration](../../../../packages/fs/tool-fs/README.md#configuration). Compile external providers and exercise add, update, delete, move, stale-version refusal, and partial source-deletion failure through their ordinary tool composition; compare final files with reported effects.
