/** Internal patch outcomes, failure diagnostics, and operation-local plans. */
import type { FsErrorCode, FsTarget } from '@deepseek-ai/dsh-fs'
import type { PatchHunk } from '@deepseek-ai/dsh-fs-patch'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'

/** One request after the caller resolves its per-call sandbox policy. */
export interface PatchExecutionRequest {
  /** Raw patch text from the model. */
  patch: string
  /** Resolved per-call policy; undefined under an unconfined backend. */
  sandboxPolicy: SandboxExecutionPolicy | undefined
}

/** One file operation; unresolved paths retain their original patch spelling on resolution failure. */
export interface PatchOperationRecord {
  /** Zero-based position in the patch. */
  index: number
  /** File effect represented by this operation. */
  kind: 'add' | 'update' | 'delete' | 'move'
  /** Source display path (created path for add), or raw patch path if resolution failed. */
  path: string
  /** Move destination display path, or raw patch path if it could not be resolved. */
  destination?: string
  /** One-based patch line of the operation header. */
  patchLine: number
}

/** LF text before and after one effect; null means absence or an unavailable provider basis. */
export interface PatchFileChange {
  /** Resolved display path that changed. */
  path: string
  /** Previous text, or null for absence or an unavailable basis. */
  before: string | null
  /** Published text, or null after deletion. */
  after: string | null
}

/** Filesystem failures plus syntax and disallowed symlink-source diagnostics. */
export type PatchFailureCode = FsErrorCode | 'PATCH_SYNTAX' | 'PATCH_SYMLINK_SOURCE'

/** Actionable diagnostic ready for model output. */
export interface PatchFailure {
  /** Stable machine-readable reason. */
  code: PatchFailureCode
  /** Message after sandbox denial mapping and filesystem remediation. */
  message: string
  /** Patch line of an unmatched hunk. */
  hunkLine?: number
}

/** Each operation retains completed effects even when a move fails halfway. */
export type PatchOperationOutcome =
  | { status: 'completed'; operation: PatchOperationRecord; changes: PatchFileChange[] }
  | { status: 'failed'; operation: PatchOperationRecord; failure: PatchFailure; changes: PatchFileChange[] }
  | { status: 'unknown'; operation: PatchOperationRecord; failure: PatchFailure }
  | { status: 'skipped'; operation: PatchOperationRecord }

/** Ordered report; preflight failures prevent all writes, commit failures stop later operations. */
export type PatchExecutionReport =
  | { phase: 'syntax'; failure: PatchFailure; outcomes: []; affectedPaths: []; cancelled: false }
  | { phase: 'preflight'; outcomes: PatchOperationOutcome[]; affectedPaths: []; cancelled: boolean }
  | { phase: 'commit'; outcomes: PatchOperationOutcome[]; affectedPaths: string[]; cancelled: boolean }

/** Resolved operation with raw source spelling retained for no-follow inspection. */
export type PlannedOperation = {
  record: PatchOperationRecord
  target: FsTarget
  rawPath: string
} & (
  | { kind: 'add'; content: string }
  | { kind: 'update'; hunks: readonly PatchHunk[] }
  | { kind: 'delete' }
  | { kind: 'move'; destination: FsTarget; hunks: readonly PatchHunk[] }
)

/** Resolved operations and per-operation path-resolution failures in one parsed patch. */
export interface PatchPlan {
  /** Successfully resolved operations, retaining their original indexes and order. */
  operations: PlannedOperation[]
  /** Resolution failures; unresolvable paths retain their raw patch spelling. */
  failures: Extract<PatchOperationOutcome, { status: 'failed' }>[]
}
