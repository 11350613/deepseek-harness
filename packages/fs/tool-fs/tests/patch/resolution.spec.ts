/** Resolution failures preserve operation order and use raw spelling only for unresolved paths. */
import { FsError } from '@deepseek-ai/dsh-fs'
import { expect, it, vi } from 'vitest'
import { add, move, patch, setup, update } from './harness.ts'

it('collects path resolution failures while retaining resolved paths and checking remaining operations', async () => {
  const t = await setup()
  await t.file('a', 'old\n')
  const resolve = t.fs.resolve.bind(t.fs)
  vi.spyOn(t.fs, 'resolve').mockImplementation(async (path, options) => {
    if (path === './denied') throw new FsError('cannot resolve denied path', 'FS_PERMISSION_DENIED')
    return resolve(path, options)
  })
  expect(await t.run(patch(update('a'), add('./denied'), add('c')))).toEqual({ phase: 'preflight', outcomes: [
    { status: 'skipped', operation: t.record('update', 'a') },
    { status: 'failed', operation: { kind: 'add', path: './denied', index: 1, patchLine: 6 },
      failure: { code: 'FS_PERMISSION_DENIED', message: 'cannot resolve denied path' }, changes: [] },
    { status: 'skipped', operation: t.record('add', 'c', 2, 8) },
  ], affectedPaths: [], cancelled: false })
  expect(await t.bytes('a')).toBe('old\n')
  await expect(t.bytes('c')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(t.observations).toEqual([])
  expect(await t.editIntent('a')).toEqual({ version: await t.version('a') })
})

it('retains a resolved move source when only its destination cannot be resolved', async () => {
  const t = await setup()
  await t.file('a', 'old\n')
  const resolve = t.fs.resolve.bind(t.fs)
  vi.spyOn(t.fs, 'resolve').mockImplementation(async (path, options) => {
    if (path === './denied') throw new FsError('destination unread', 'FS_NOT_OBSERVED')
    return resolve(path, options)
  })
  expect(await t.run(patch(move('a', './denied'), update('a')))).toEqual({ phase: 'preflight', outcomes: [
    { status: 'failed', operation: { ...t.record('move', 'a'), destination: './denied' },
      failure: { code: 'FS_NOT_OBSERVED', message: 'cannot modify "./denied": file has not been read — read the file, then retry' }, changes: [] },
    { status: 'skipped', operation: t.record('update', 'a', 1, 7) },
  ], affectedPaths: [], cancelled: false })
  expect(await t.bytes('a')).toBe('old\n')
  expect(t.observations).toEqual([])
  expect(await t.editIntent('a')).toEqual({ version: await t.version('a') })
})

it('returns cancelled resolution records for a signal aborted before entry', async () => {
  const t = await setup()
  t.controller.abort()
  expect(await t.run(patch(add('a'), move('b', 'c')))).toEqual({ phase: 'preflight', outcomes: [
    { status: 'failed', operation: { kind: 'add', path: 'a', index: 0, patchLine: 2 },
      failure: { code: 'FS_ABORTED', message: 'resolve aborted' }, changes: [] },
    { status: 'failed', operation: { kind: 'move', path: 'b', destination: 'c', index: 1, patchLine: 4 },
      failure: { code: 'FS_ABORTED', message: 'resolve aborted' }, changes: [] },
  ], affectedPaths: [], cancelled: true })
  await expect(t.bytes('a')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(t.observations).toEqual([])
  await expect(t.editIntent('a')).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
})
