/** Trusted-window original-file saves and clipboard transfers. Saved paths stay in the main process. */
import { app, clipboard, ClipboardItem, dialog, ipcMain, nativeImage, shell } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FileSaveResult, SavedFileId } from '@deepseek-ai/dsh-client-ui-file-actions/types'
import { DESKTOP_IPC } from './ipc.ts'
import { resolveDurationMs } from './duration-env.ts'

/** @param request - untrusted IPC input. @returns checked original bytes and destination policy. */
function saveRequest(request: unknown): { bytes: Uint8Array; name: string; mode: 'download' | 'saveAs' } {
  if (typeof request !== 'object' || request === null || !('bytes' in request) || !(request.bytes instanceof Uint8Array)
    || !('name' in request) || typeof request.name !== 'string' || request.name.length === 0
    || basename(request.name) !== request.name || /[<>:"/\\|?*\x00-\x1f]/u.test(request.name)
    || request.name === '.' || request.name === '..'
    || Buffer.byteLength(request.name) > 255 || /[. ]$/u.test(request.name)
    || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(request.name)
    || !('mode' in request) || (request.mode !== 'download' && request.mode !== 'saveAs')) throw new Error('Invalid file save request')
  return { bytes: request.bytes, name: request.name, mode: request.mode }
}

/**
 * Save without overwriting a download; explicit save-as replaces only after the complete write.
 * @param bytes - unmodified original content.
 * @param destination - main-process destination from Downloads or the native picker.
 * @param replace - picker-confirmed replacement.
 * @returns committed destination.
 */
export async function saveOriginal(bytes: Uint8Array, destination: string, replace: boolean): Promise<string> {
  if (replace) {
    const temporary = join(dirname(destination), `.dsh-save-${randomUUID()}`)
    try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, destination) }
    finally { await rm(temporary, { force: true }) }
    return destination
  }
  const extension = extname(destination)
  const stem = destination.slice(0, destination.length - extension.length)
  for (let index = 0; ; index++) {
    const path = index === 0 ? destination : `${stem} (${index})${extension}`
    let file
    try { file = await open(path, 'wx') }
    catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') continue
      throw error
    }
    try { await file.writeFile(bytes) }
    catch (error) { await file.close(); await rm(path, { force: true }); throw error }
    await file.close()
    return path
  }
}

/** @param assertOwner - rejects shell pages, subframes, and unowned windows. */
export function installFileActions(assertOwner: (event: IpcMainInvokeEvent) => BrowserWindow): void {
  const saved = new Map<SavedFileId, { owner: BrowserWindow; path: string }>()
  const owners = new WeakSet<BrowserWindow>()
  const timeoutMs = resolveDurationMs(process.env, 'DSH_DESKTOP_IMAGE_READ_TIMEOUT_MS', 30_000)
  const maxBytes = Number(process.env.DSH_DESKTOP_IMAGE_READ_MAX_BYTES ?? 64 * 1024 * 1024)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('DSH_DESKTOP_IMAGE_READ_MAX_BYTES must be a positive integer')
  const retainOwner = (owner: BrowserWindow): void => {
    if (owners.has(owner)) return
    owners.add(owner)
    const clear = (): void => {
      for (const [id, entry] of saved) if (entry.owner === owner) saved.delete(id)
    }
    owner.webContents.on('did-start-loading', clear)
    owner.once('closed', () => { clear(); owner.webContents.removeListener('did-start-loading', clear) })
  }
  ipcMain.handle(DESKTOP_IPC.fileSave, async (event, value: unknown): Promise<FileSaveResult> => {
    const owner = assertOwner(event)
    const request = saveRequest(value)
    let destination = join(app.getPath('downloads'), request.name)
    if (request.mode === 'saveAs') {
      const result = await dialog.showSaveDialog(owner, { defaultPath: destination, properties: ['showOverwriteConfirmation', 'createDirectory'] })
      if (result.canceled || !result.filePath || owner.isDestroyed()) return { status: 'cancelled' }
      destination = result.filePath
    }
    assertOwner(event)
    const path = await saveOriginal(request.bytes, destination, request.mode === 'saveAs')
    if (owner.isDestroyed()) return { status: 'saved' }
    assertOwner(event)
    retainOwner(owner)
    const fileId = randomUUID() as SavedFileId
    saved.set(fileId, { owner, path })
    return { status: 'saved', fileId }
  })
  ipcMain.handle(DESKTOP_IPC.fileReveal, async (event, id: unknown) => {
    const owner = assertOwner(event)
    const entry = typeof id === 'string' ? saved.get(id as SavedFileId) : undefined
    if (entry === undefined || entry.owner !== owner) throw new Error('Saved file unavailable')
    if (!(await stat(entry.path)).isFile()) throw new Error('Saved file unavailable')
    assertOwner(event)
    shell.showItemInFolder(entry.path)
  })
  ipcMain.handle(DESKTOP_IPC.imageCopy, async (event, bytes: unknown) => {
    assertOwner(event)
    if (!(bytes instanceof Uint8Array)) throw new Error('Invalid clipboard image')
    const image = nativeImage.createFromBuffer(Buffer.from(bytes))
    if (image.isEmpty()) throw new Error('Image cannot be decoded')
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())]) })])
  })
  ipcMain.handle(DESKTOP_IPC.imageRead, async (event, value: unknown) => {
    const owner = assertOwner(event)
    if (typeof value !== 'string') throw new Error('Invalid image URL')
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid image URL')
    const lifetime = new AbortController()
    const abort = (): void => { lifetime.abort() }
    owner.once('closed', abort)
    owner.webContents.once('did-start-loading', abort)
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeoutMs)]), credentials: 'omit', referrerPolicy: 'no-referrer',
      })
      if (!response.ok) throw new Error('Original image unavailable')
      const reader = response.body?.getReader()
      if (reader === undefined) throw new Error('Original image unavailable')
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > maxBytes) throw new Error('Original image exceeds the download limit')
          chunks.push(chunk.value)
        }
      } finally { await reader.cancel(); reader.releaseLock() }
      assertOwner(event)
      lifetime.signal.throwIfAborted()
      return { bytes: new Uint8Array(Buffer.concat(chunks)), mediaType: response.headers.get('content-type') ?? '' }
    } finally {
      owner.removeListener('closed', abort)
      owner.webContents.removeListener('did-start-loading', abort)
    }
  })
}
