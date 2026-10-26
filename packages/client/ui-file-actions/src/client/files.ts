/** Original-byte transfer, platform save selection, and pasteable image encoding. */
import { resolveDragFileName } from '@deepseek-ai/dsh-util-file-drag'
import type { DesktopFileActions, FileActions, FileActionSource, FileSaveResult, SavedFileId } from '../types.ts'

/**
 * Keep compatible filename suffixes and repair known MIME conflicts without changing bytes.
 * @param name - suggested original name.
 * @param mediaType - source MIME, optionally including parameters.
 * @returns safe filename preserving unknown formats.
 */
export function exportName(name: string | undefined, mediaType: string): string {
  return resolveDragFileName({ name: name ?? 'image', mediaType })
}

type SavePicker = (options: { suggestedName: string }) => Promise<{
  createWritable(): Promise<{ write(blob: Blob): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>
}>

/** File action owner; native saved references never imply paths for browser downloads. */
export class BrowserFileActions implements FileActions {
  private readonly saved = new Map<string, SavedFileId>()
  private downloadUrl: string | undefined
  private readonly lifetime = new AbortController()
  private readonly picker = (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker?.bind(window)
  readonly canSaveAs: boolean
  constructor(private readonly desktop: DesktopFileActions | undefined) {
    this.canSaveAs = desktop !== undefined || this.picker !== undefined
  }
  savedFile(url: string): SavedFileId | undefined { return this.saved.get(url) }
  async reveal(id: SavedFileId): Promise<void> {
    if (this.desktop === undefined) throw new Error('File manager unavailable')
    await this.desktop.reveal(id)
  }
  private async read(source: FileActionSource): Promise<Blob> {
    this.lifetime.signal.throwIfAborted()
    if (source.read !== undefined) return source.read(this.lifetime.signal)
    const url = new URL(source.url)
    if (!['http:', 'https:', 'blob:', 'data:', 'dsh-app:'].includes(url.protocol)) throw new Error('Unsupported file source')
    if (this.desktop !== undefined && ['http:', 'https:'].includes(url.protocol) && url.origin !== location.origin) {
      const content = await this.desktop.readClipboardImage(url.href)
      this.lifetime.signal.throwIfAborted()
      return new Blob([new Uint8Array(content.bytes)], { type: content.mediaType || source.mediaType || '' })
    }
    const response = await fetch(source.url, { signal: this.lifetime.signal, referrerPolicy: 'no-referrer' })
    if (!response.ok) throw new Error('Original file unavailable')
    return response.blob()
  }
  async save(source: FileActionSource, mode: 'download' | 'saveAs'): Promise<FileSaveResult> {
    this.lifetime.signal.throwIfAborted()
    if (this.desktop !== undefined) {
      const blob = source.read === undefined ? undefined : await source.read(this.lifetime.signal)
      this.lifetime.signal.throwIfAborted()
      const url = blob === undefined ? source.url : URL.createObjectURL(blob)
      try {
        const result = await this.desktop.save({ url, mode,
          ...(source.name === undefined ? {} : { name: source.name }),
          ...(blob?.type || source.mediaType ? { mediaType: blob?.type || source.mediaType } : {}),
        })
        this.lifetime.signal.throwIfAborted()
        if (result.status === 'saved' && result.fileId !== undefined) this.saved.set(source.url, result.fileId)
        return result
      } finally { if (blob !== undefined) URL.revokeObjectURL(url) }
    }
    // The Web picker must be requested in the gesture, before reading the source loses activation.
    const suggested = source.name ?? (URL.canParse(source.url) ? new URL(source.url).pathname.split('/').pop() : undefined)
    const picked = mode === 'saveAs'
      ? this.picker?.({ suggestedName: exportName(suggested, source.mediaType ?? '') }) : undefined
    if (mode === 'saveAs' && picked === undefined) throw new Error('Save picker unavailable')
    const handle = picked === undefined ? undefined : await picked.catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return null
      throw error
    })
    if (handle === null) return { status: 'cancelled' }
    const blob = await this.read(source)
    this.lifetime.signal.throwIfAborted()
    const name = exportName(suggested, blob.type || source.mediaType || '')
    if (handle !== undefined) {
      const writable = await handle.createWritable()
      try { await writable.write(blob); await writable.close() }
      catch (error) { await writable.abort(); throw error }
    } else {
      const url = URL.createObjectURL(blob)
      if (this.downloadUrl !== undefined) URL.revokeObjectURL(this.downloadUrl)
      this.downloadUrl = url
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = name
      document.body.append(anchor); anchor.click(); anchor.remove()
      return { status: 'requested' }
    }
    return { status: 'saved' }
  }
  async copyImage(source: FileActionSource): Promise<void> {
    this.lifetime.signal.throwIfAborted()
    const png = this.read(source).then(async (blob) => {
      this.lifetime.signal.throwIfAborted()
      if (blob.type === 'image/png') return blob
      const objectUrl = URL.createObjectURL(blob)
      const image = new Image()
      image.src = objectUrl
      await image.decode().catch((error: unknown) => { URL.revokeObjectURL(objectUrl); throw error })
      try {
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
        const context = canvas.getContext('2d')
        if (context === null) throw new Error('Image conversion unavailable')
        context.drawImage(image, 0, 0)
        return await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((value) => {
            if (value === null) reject(new Error('Image conversion failed'))
            else resolve(value)
          }, 'image/png')
        })
      } finally { URL.revokeObjectURL(objectUrl) }
    })
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
  }
  /** Cancel reads and release browser download URLs when the plugin unloads. */
  dispose(): void {
    this.lifetime.abort()
    if (this.downloadUrl !== undefined) URL.revokeObjectURL(this.downloadUrl)
    this.downloadUrl = undefined
    this.saved.clear()
  }
}
