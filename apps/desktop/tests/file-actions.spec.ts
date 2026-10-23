/** Native original-byte saves and window-scoped IPC ownership. */
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { installFileActions, saveOriginal } from '../src/file-actions.ts'
import { DESKTOP_IPC } from '../src/ipc.ts'

const electron = vi.hoisted(() => ({
  app: { getPath: vi.fn() }, ipcMain: { handle: vi.fn() }, dialog: { showSaveDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
}))
vi.mock('electron', () => electron)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); vi.clearAllMocks(); vi.unstubAllGlobals()
})
async function directory() { const path = await mkdtemp(join(tmpdir(), 'dsh-file-actions-')); roots.push(path); return path }

it('preserves originals, avoids download collisions, and commits explicit replacements', async () => {
  const root = await directory(), path = join(root, 'original.gif'), bytes = new Uint8Array([0, 128, 255])
  await writeFile(path, 'previous')
  const copy = await saveOriginal(bytes, path, false)
  expect(copy).toBe(join(root, 'original (1).gif'))
  expect(await readFile(path, 'utf8')).toBe('previous')
  expect(await readFile(copy)).toEqual(Buffer.from(bytes))
  await saveOriginal(bytes, path, true)
  expect(await readFile(path)).toEqual(Buffer.from(bytes))
  expect((await readdir(root)).sort()).toEqual(['original (1).gif', 'original.gif'])
})

function harness(root: string) {
  const owner = Object.assign(new EventEmitter(), { webContents: new EventEmitter(), isDestroyed: () => false })
  const assertOwner = vi.fn(() => owner as BrowserWindow)
  electron.app.getPath.mockReturnValue(root)
  installFileActions(assertOwner)
  const event = {} as IpcMainInvokeEvent
  const invoke = async (channel: string, value: unknown): Promise<unknown> => {
    const handler = electron.ipcMain.handle.mock.calls.find(([name]) => name === channel)?.[1] as
      (event: IpcMainInvokeEvent, value: unknown) => Promise<unknown>
    return handler(event, value)
  }
  return { owner, assertOwner, invoke }
}

it('reveals only its saved references and retires them on navigation', async () => {
  const f = harness(await directory())
  const result = await f.invoke(DESKTOP_IPC.fileSave, { bytes: new Uint8Array([1]), name: 'image.gif', mode: 'download' }) as { fileId: string }
  await f.invoke(DESKTOP_IPC.fileReveal, result.fileId)
  expect(electron.shell.showItemInFolder).toHaveBeenCalledTimes(1)
  f.owner.webContents.emit('did-start-navigation', {}, 'dsh-app://app/', false, true)
  await expect(f.invoke(DESKTOP_IPC.fileReveal, result.fileId)).rejects.toThrow('unavailable')
  f.owner.emit('closed')
  expect(f.owner.webContents.listenerCount('did-start-navigation')).toBe(0)
})

it.each(['../bad', 'CON.gif', 'name.', 'x'.repeat(256)])('rejects unsafe IPC filename %s', async (name) => {
  const root = await directory(), f = harness(root)
  await expect(f.invoke(DESKTOP_IPC.fileSave, { bytes: new Uint8Array(), name, mode: 'download' })).rejects.toThrow('Invalid')
  expect(await readdir(root)).toEqual([])
})

it('treats picker cancellation as normal and rejects an unowned caller before saving', async () => {
  const root = await directory(), f = harness(root)
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: true })
  expect(await f.invoke(DESKTOP_IPC.fileSave, { bytes: new Uint8Array(), name: 'a.gif', mode: 'saveAs' })).toEqual({ status: 'cancelled' })
  f.assertOwner.mockImplementation(() => { throw new Error('Rejected owner') })
  await expect(f.invoke(DESKTOP_IPC.fileSave, {})).rejects.toThrow('Rejected owner')
  expect(await readdir(root)).toEqual([])
})

it('aborts original-image reads on window navigation and releases lifecycle listeners', async () => {
  const f = harness(await directory())
  let signal!: AbortSignal
  vi.stubGlobal('fetch', vi.fn((_url: URL, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    signal = options.signal!
    signal.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
  })))
  const reading = f.invoke(DESKTOP_IPC.imageRead, 'https://images.example/original.gif')
  f.owner.webContents.emit('did-start-navigation', {}, 'dsh-app://app/', false, true)
  await expect(reading).rejects.toThrow('Aborted')
  expect(signal.aborted).toBe(true)
  expect(f.owner.listenerCount('closed')).toBe(0)
  expect(f.owner.webContents.listenerCount('did-start-navigation')).toBe(0)
})

it('preserves saved references across iframe and same-document navigation', async () => {
  const f = harness(await directory())
  const result = await f.invoke(DESKTOP_IPC.fileSave, { bytes: new Uint8Array([1]), name: 'saved.png', mode: 'download' }) as { fileId: string }
  f.owner.webContents.emit('did-start-navigation', {}, 'https://example.org', false, false)
  f.owner.webContents.emit('did-start-navigation', {}, 'dsh-app://app/#tab', true, true)
  await expect(f.invoke(DESKTOP_IPC.fileReveal, result.fileId)).resolves.toBeUndefined()
  f.owner.emit('closed')
})

it('rejects redirects to the application Host', async () => {
  const root = await directory()
  const owner = Object.assign(new EventEmitter(), { webContents: new EventEmitter(), isDestroyed: () => false })
  installFileActions(() => owner as BrowserWindow, () => 'http://127.0.0.1:19321')
  const handler = (name: string) => electron.ipcMain.handle.mock.calls.find(([channel]) => channel === name)![1] as
    (event: IpcMainInvokeEvent, value: unknown) => Promise<unknown>
  const fetchImage = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://localhost:19321/api/private' } }))
  vi.stubGlobal('fetch', fetchImage)
  const event = {} as IpcMainInvokeEvent
  await expect(handler(DESKTOP_IPC.imageRead)(event, 'https://images.example/photo')).rejects.toThrow('Invalid image URL')
  expect(fetchImage).toHaveBeenCalledOnce()
  expect(await readdir(root)).toEqual([])
})
