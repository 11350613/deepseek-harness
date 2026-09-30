/** Pure patch parsing and mutation-path enumeration, independent of filesystem providers. */

import type { PatchOperation } from './types.ts'

export { parsePatch, PatchParseError } from './parse.ts'
export type { PatchHunk, PatchOperation } from './types.ts'

/**
 * Collect source paths and move destinations in first-seen order for pre-mutation capture.
 * @param operations - parsed operations; repeated operations remain intact.
 * @returns unique path strings, without resolving aliases or applying filesystem policy.
 */
export function collectMutationPaths(operations: readonly PatchOperation[]): string[] {
  const paths = new Set<string>()
  for (const operation of operations) {
    paths.add(operation.path)
    if (operation.kind === 'update' && operation.moveTo !== undefined) paths.add(operation.moveTo)
  }
  return [...paths]
}
