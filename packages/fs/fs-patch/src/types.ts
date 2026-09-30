/** Serializable syntax records for Codex-style file patches; paths remain unresolved. */

/** One contiguous update, with zero-based indices identifying explicit context lines. */
export interface PatchHunk {
  /** One-based input line containing the marker or first implicit hunk line. */
  lineNumber: number
  /** Text following `@@ `, used as a search anchor by the text matcher. */
  context?: string
  /** Context and removed lines, without patch prefixes or line endings. */
  oldLines: string[]
  /** Context and added lines, without patch prefixes or line endings. */
  newLines: string[]
  /** Corresponding old/new offsets for context; identical remove/add pairs are excluded. */
  contextLineIndices: [number, number][]
  /** Whether `*** End of File` follows this hunk. */
  isEndOfFile: boolean
}

/** Ordered file operation; a move is an update with a destination path. */
export type PatchOperation =
  | {
    kind: 'add'
    path: string
    lineNumber: number
    /** Added lines joined with LF, including a final LF for every added line. */
    content: string
  }
  | {
    kind: 'delete'
    path: string
    lineNumber: number
  }
  | {
    kind: 'update'
    path: string
    lineNumber: number
    moveTo?: string
    hunks: PatchHunk[]
  }
