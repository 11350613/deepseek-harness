/** Exact Host projections and stopped output without invented file effects. */
import { expect, it, vi } from 'vitest'
import * as Patch from '@deepseek-ai/dsh-fs-patch'
import { presentPatchCall, presentPatchResult } from '../src/apply-patch-presentation.ts'
import { renderPatch, patchPresentationMeta, type PatchToolValue } from '../src/apply-patch-output.ts'
import { stoppedFromMeta } from '../src/diff.ts'
import { add, move, patch, remove, setup, update } from './patch/harness.ts'

it('previews every operation using raw paths and both move endpoints', async () => {
  const text = patch(add('a'), update('b'), remove('c'), move('d', 'e'), '*** Update File: empty\n@@\n+insert')
  const expected = { card: 'diff', title: 'Apply patch (5 files)', diffs: [
    { path: 'a', oldText: null, newText: 'new\n' }, { path: 'b', oldText: 'old', newText: 'new' },
    { path: 'c', oldText: null, newText: '' }, { path: 'd', oldText: 'old', newText: 'new' },
    { path: 'empty', oldText: null, newText: 'insert' },
  ], locations: ['a', 'b', 'c', 'd', 'e', 'empty'].map(path => ({ path })) }
  expect(presentPatchCall(text)).toEqual(expected)
  const t = await setup({ enableApplyPatch: true })
  expect(t.ctx.tools.get('apply_patch')?.presentCall?.({ patch: text })).toEqual(expected)
  expect(presentPatchCall('invalid')).toBeUndefined()
})

it('propagates unexpected parser defects', () => {
  const defect = new Error('parser defect')
  const spy = vi.spyOn(Patch, 'parsePatch').mockImplementation(() => { throw defect })
  try { expect(() => presentPatchCall('text')).toThrow(defect) } finally { spy.mockRestore() }
})

it('falls back on failed or missing metadata and titles known stopped diffs', async () => {
  const diffs = [{ path: 'a', oldText: 'old', newText: 'new' }]
  const result = { isError: false, content: [], meta: { diffs } }
  expect(presentPatchResult({ ...result, isError: true })).toBeUndefined()
  expect(presentPatchResult({ isError: false, content: [] })).toBeUndefined()
  expect(presentPatchResult(result)).toEqual({ card: 'diff', title: 'Apply patch', diffs })
  const stopped = { ...result, meta: { diffs, stopped: true } }
  expect(presentPatchResult(stopped)).toEqual({ card: 'diff', title: 'Apply patch (stopped)', diffs })
  const t = await setup({ enableApplyPatch: true })
  expect(t.ctx.tools.get('apply_patch')?.presentResult?.({ patch: patch() }, stopped))
    .toEqual({ card: 'diff', title: 'Apply patch (stopped)', diffs })
})

it.each([undefined, null, [], 'stopped', {}, { stopped: 'true' }, { stopped: false }])('rejects a malformed stopped flag %j', (meta) => {
  expect(stoppedFromMeta(meta)).toBe(false)
})

it('presents nullable creation/deletion baselines and omits unavailable changes', () => {
  const value: PatchToolValue = { phase: 'commit', cancelled: false, affectedPaths: ['a', 'b'], operations: [
    { index: 0, kind: 'delete', path: 'a', patchLine: 2, status: 'completed', changes: [{ path: 'a', before: null, after: null }] },
    { index: 1, kind: 'update', path: 'b', patchLine: 3, status: 'failed', code: 'FS_PERMISSION_DENIED', message: 'denied' },
    { index: 2, kind: 'add', path: 'c', patchLine: 7, status: 'skipped' },
  ] }
  expect(patchPresentationMeta(value)).toEqual({ stopped: true, diffs: [{ path: 'a', oldText: null, newText: '' }] })
  expect(renderPatch(value)).toBe('Patch stopped after 1 of 3 operations.\nCompleted:\nD a\nFailed:\n'
    + '- operation 2 (update b, patch line 3): denied\nNot executed:\n- operation 3 (add c)')
})

it('reports cancellation and a move failure with no written destination', () => {
  const value: PatchToolValue = { phase: 'commit', cancelled: true, affectedPaths: [], operations: [
    { index: 0, kind: 'move', path: 'a', destination: 'b', patchLine: 2, status: 'failed', message: 'cancelled', changes: [] },
    { index: 1, kind: 'delete', path: 'c', patchLine: 7, status: 'skipped' },
  ] }
  expect(renderPatch(value)).toBe('Patch stopped after 0 of 2 operations.\nFailed:\n'
    + '- operation 1 (move a -> b, patch line 2): cancelled\nNot executed:\n- operation 2 (delete c)')
})
