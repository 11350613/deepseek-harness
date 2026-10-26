// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserFileActions, exportName } from '../src/client/files.ts'
import type { DesktopFileActions, SavedFileId } from '../src/types.ts'
import { Context } from '@deepseek-ai/cordis'
import { apply as clientApply } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

beforeEach(() => {
  vi.stubGlobal('ClipboardItem', class {
    constructor(readonly content: Record<string, Promise<Blob>>) {}
  })
  vi.stubGlobal('navigator', { clipboard: { write: vi.fn(async (items: { content: Record<string, Promise<Blob>> }[]) => {
    await items[0]!.content['image/png']
  }) } })
})

function fakeImage(width: number, height: number) {
  const image = { naturalWidth: width, naturalHeight: height, src: '', decode: vi.fn(async () => {}) }
  vi.stubGlobal('Image', function Image() { return image })
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = vi.fn(() => 'blob:conversion')
    static override revokeObjectURL = vi.fn()
  })
  return image
}

function native(): DesktopFileActions {
  return { save: vi.fn(async () => ({ status: 'saved' as const, fileId: 'saved' as SavedFileId })),
    readClipboardImage: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/webp' })),
    reveal: vi.fn(async () => {}) }
}

describe('original filenames', () => {
  it.each([
    ['photo.jpeg', 'image/jpeg', 'photo.jpeg'],
    ['photo.PNG', 'image/png; charset=binary', 'photo.PNG'],
    ['photo.png', 'image/webp', 'photo.webp'],
    ['animation', 'image/gif', 'animation.gif'],
    ['drawing.custom', 'application/x-custom', 'drawing.custom'],
    ['CON.png', 'image/png', '_CON.png'],
    ['../a:b.png', 'image/png', '_a_b.png'],
    ['... ', 'image/png', 'file.png'],
  ])('names %s from %s', (name, mime, expected) => { expect(exportName(name, mime)).toBe(expected) })
  it('bounds multibyte names and unusually long extensions', () => {
    expect(exportName(undefined, '')).toBe('image')
    for (const name of ['图'.repeat(300) + '.png', 'a.' + 'x'.repeat(1000)]) {
      expect(new TextEncoder().encode(exportName(name, '')).length).toBeLessThanOrEqual(255)
    }
  })
})

describe('file actions', () => {
  it('saves the original encoded bytes and only retains successfully returned native references', async () => {
    vi.stubGlobal('Blob', NodeBlob)
    const bridge = native(), actions = new BrowserFileActions(bridge)
    const source = { url: 'https://images.example/chart', name: 'chart.png', mediaType: 'image/png' }
    expect(actions.savedFile(source.url)).toBeUndefined()
    await actions.save(source, 'download')
    expect(bridge.save).toHaveBeenCalledWith({ ...source, mode: 'download' })
    expect(bridge.readClipboardImage).not.toHaveBeenCalled()
    expect(actions.savedFile(source.url)).toBe('saved')
    await actions.reveal('saved' as SavedFileId)
    expect(bridge.reveal).toHaveBeenCalledWith('saved')
    vi.mocked(bridge.save).mockResolvedValue({ status: 'cancelled' })
    await expect(actions.save({ ...source, url: source.url + '2' }, 'saveAs')).resolves.toEqual({ status: 'cancelled' })
    expect(actions.savedFile(source.url + '2')).toBeUndefined()
    actions.dispose()
  })
  it('uses an authorized resource reader without converting bytes', async () => {
    vi.stubGlobal('Blob', NodeBlob)
    const bridge = native(), actions = new BrowserFileActions(bridge)
    fakeImage(1, 1)
    const bytes = new Uint8Array([0, 255, 128, 10])
    await actions.save({ url: 'file-identity', name: 'report.bin', read: async () => new Blob([bytes]) }, 'saveAs')
    expect(bridge.readClipboardImage).not.toHaveBeenCalled()
    expect(bridge.save).toHaveBeenCalledWith({ url: 'blob:conversion', name: 'report.bin', mode: 'saveAs' })
    expect(vi.mocked(URL).revokeObjectURL).toHaveBeenCalledWith('blob:conversion')
    actions.dispose()
  })
  it('requests the browser picker during activation and treats picker cancellation as normal', async () => {
    const read = vi.fn(async () => new Blob())
    const picker = vi.fn(() => Promise.reject(new DOMException('cancelled', 'AbortError')))
    vi.stubGlobal('showSaveFilePicker', picker)
    const actions = new BrowserFileActions(undefined)
    const saving = actions.save({ url: 'original', name: 'a.gif', read }, 'saveAs')
    expect(picker).toHaveBeenCalledWith({ suggestedName: 'a.gif' })
    await expect(saving).resolves.toEqual({ status: 'cancelled' })
    expect(read).not.toHaveBeenCalled()
    actions.dispose()
  })
  it('writes the browser file and never invents a native reference', async () => {
    const writable = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) }
    vi.stubGlobal('showSaveFilePicker', vi.fn(async () => ({ createWritable: async () => writable })))
    const actions = new BrowserFileActions(undefined), blob = new Blob(['original'])
    await expect(actions.save({ url: 'identity', read: async () => blob }, 'saveAs')).resolves.toEqual({ status: 'saved' })
    expect(writable.write).toHaveBeenCalledWith(blob)
    expect(writable.close).toHaveBeenCalledOnce()
    expect(actions.savedFile('identity')).toBeUndefined()
    actions.dispose()
  })
  it('does not save a remote read that finishes after the plugin unloads', async () => {
    const bridge = native()
    let settle!: (value: Blob) => void
    const read = vi.fn(() => new Promise<Blob>((resolve) => { settle = resolve }))
    const actions = new BrowserFileActions(bridge)
    const pending = actions.save({ url: 'https://example.org/image', read }, 'download')
    actions.dispose(); settle(new Blob())
    await expect(pending).rejects.toThrow()
    expect(bridge.save).not.toHaveBeenCalled()
  })
  it('converts a browser-decodable original to PNG for the browser clipboard in Desktop', async () => {
    vi.stubGlobal('Blob', NodeBlob)
    const bitmap = fakeImage(2, 3)
    const drawImage = vi.fn()
    // jsdom has no canvas renderer; the browser scenario verifies actual GIF decoding.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => { callback(new Blob(['PNG'], { type: 'image/png' })) })
    const bridge = native(), actions = new BrowserFileActions(bridge)
    const write = vi.spyOn(navigator.clipboard, 'write')
    await actions.copyImage({ url: 'https://example.org/image' })
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0)
    expect(vi.mocked(URL).revokeObjectURL).toHaveBeenCalledWith('blob:conversion')
    expect(write).toHaveBeenCalledOnce()
    actions.dispose()
  })

  it('releases original browser download URLs and never exposes a fabricated saved path', async () => {
    const blob = new Blob(['original'], { type: 'image/gif' })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => blob })))
    const create = vi.fn().mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second')
    const revoke = vi.fn(), click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.stubGlobal('URL', class extends URL { static override createObjectURL = create; static override revokeObjectURL = revoke })
    const actions = new BrowserFileActions(undefined)
    expect(actions.canSaveAs).toBe(false)
    await expect(actions.save({ url: 'https://images.example/original.gif' }, 'download')).resolves.toEqual({ status: 'requested' })
    await expect(actions.save({ url: 'https://images.example/original.gif' }, 'download')).resolves.toEqual({ status: 'requested' })
    expect(create).toHaveBeenCalledWith(blob)
    expect(click).toHaveBeenCalledTimes(2)
    expect(revoke).toHaveBeenCalledWith('blob:first')
    expect(actions.savedFile('https://images.example/original.gif')).toBeUndefined()
    await expect(actions.reveal('missing' as SavedFileId)).rejects.toThrow('unavailable')
    actions.dispose()
    expect(revoke).toHaveBeenLastCalledWith('blob:second')
    await expect(actions.save({ url: 'https://images.example/original.gif' }, 'download')).rejects.toThrow()
  })

  it('does not write when the picker, network, or destination fails', async () => {
    const actions = new BrowserFileActions(undefined)
    await expect(actions.save({ url: 'identity' }, 'saveAs')).rejects.toThrow('picker unavailable')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
    await expect(actions.save({ url: 'https://images.example/missing' }, 'download')).rejects.toThrow('unavailable')
    actions.dispose()
    vi.stubGlobal('showSaveFilePicker', vi.fn(async () => { throw new Error('Picker unavailable') }))
    const rejected = new BrowserFileActions(undefined)
    await expect(rejected.save({ url: 'identity' }, 'saveAs')).rejects.toThrow('Picker unavailable')
    rejected.dispose()
    const writable = { write: vi.fn(async () => { throw new Error('Disk full') }), close: vi.fn(), abort: vi.fn() }
    vi.stubGlobal('showSaveFilePicker', vi.fn(async () => ({ createWritable: async () => writable })))
    const writing = new BrowserFileActions(undefined)
    await expect(writing.save({ url: 'identity', read: async () => new Blob() }, 'saveAs')).rejects.toThrow('Disk full')
    expect(writable.abort).toHaveBeenCalledOnce()
    expect(writable.close).not.toHaveBeenCalled()
    writing.dispose()
  })

  it.each(['canvas', 'encoding'] as const)('releases a decoded image when %s conversion fails', async (failure) => {
    fakeImage(1, 1)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(failure === 'canvas' ? null : { drawImage: vi.fn() } as never)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => { callback(null) })
    const bridge = native(), actions = new BrowserFileActions(bridge)
    await expect(actions.copyImage({ url: 'identity', read: async () => new Blob([], { type: 'image/gif' }) })).rejects.toThrow('conversion')
    expect(vi.mocked(URL).revokeObjectURL).toHaveBeenCalledWith('blob:conversion')
    actions.dispose()
  })

  it.each([false, true])('passes a PNG promise to the browser clipboard during the gesture (Desktop: %s)', async (desktop) => {
    const blob = new Blob(['png'], { type: 'image/png' })
    let content!: Record<string, Promise<Blob>>
    vi.stubGlobal('ClipboardItem', function ClipboardItem(value: Record<string, Promise<Blob>>) { content = value })
    const write = vi.fn(async () => { await content['image/png'] })
    vi.stubGlobal('navigator', { clipboard: { write } })
    const actions = new BrowserFileActions(desktop ? native() : undefined)
    await actions.copyImage({ url: 'identity', read: async () => blob })
    expect(await content['image/png']).toBe(blob)
    expect(write).toHaveBeenCalledOnce()
    actions.dispose()
  })

  it.each([false, true])('binds the optional Desktop adapter (%s) for the plugin lifetime', async (desktop) => {
    const bridge = native()
    if (desktop) vi.stubGlobal('dshDesktop', { fileActions: bridge })
    const ctx = new Context(), fiber = ctx.plugin({ apply: clientApply })
    await fiber.await()
    expect(hostApply).not.toThrow()
    expect(ctx.fileActions.canSaveAs).toBe(desktop)
    await fiber.dispose()
  })
})


it('releases an object URL when the source image cannot decode', async () => {
  const image = fakeImage(1, 1)
  image.decode.mockRejectedValue(new Error('Decode failed'))
  const actions = new BrowserFileActions(native())
  try {
    await expect(actions.copyImage({ url: 'identity', read: async () => new Blob([], { type: 'image/gif' }) }))
      .rejects.toThrow('Decode failed')
    expect(vi.mocked(URL).revokeObjectURL).toHaveBeenCalledWith('blob:conversion')
  } finally { actions.dispose() }
})

it('passes captured URLs and suggested MIME to the native download without reading bytes', async () => {
  const bridge = native(), actions = new BrowserFileActions(bridge)
  try {
    await actions.save({ url: 'https://example.com/image', name: 'image', mediaType: 'image/gif' }, 'download')
    expect(bridge.save).toHaveBeenCalledWith({ url: 'https://example.com/image', name: 'image', mediaType: 'image/gif', mode: 'download' })
    expect(bridge.readClipboardImage).not.toHaveBeenCalled()
  } finally { actions.dispose() }
})

it('lets Chromium name URL-only downloads and keeps authorized MIME when no name is supplied', async () => {
  const bridge = native(), actions = new BrowserFileActions(bridge)
  fakeImage(1, 1)
  try {
    await actions.save({ url: 'https://example.com/image' }, 'download')
    expect(bridge.save).toHaveBeenLastCalledWith({ url: 'https://example.com/image', mode: 'download' })
    await actions.save({ url: 'authorized-image', read: async () => new Blob(['GIF'], { type: 'image/gif' }) }, 'saveAs')
    expect(bridge.save).toHaveBeenLastCalledWith({ url: 'blob:conversion', mediaType: 'image/gif', mode: 'saveAs' })
  } finally { actions.dispose() }
})

it('rejects unsupported clipboard sources and uses suggested MIME when a remote response has none', async () => {
  const bridge = native(), actions = new BrowserFileActions(bridge)
  const write = vi.spyOn(navigator.clipboard, 'write')
  vi.mocked(bridge.readClipboardImage).mockResolvedValue({ bytes: new Uint8Array([1, 2]), mediaType: '' })
  fakeImage(1, 1)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => { callback(new Blob(['PNG'], { type: 'image/png' })) })
  try {
    await expect(actions.copyImage({ url: 'file:///private/image.png' })).rejects.toThrow('Unsupported')
    write.mockClear()
    await actions.copyImage({ url: 'https://example.com/image', mediaType: 'image/png' })
    await actions.copyImage({ url: 'https://example.com/untyped-image' })
    expect(write).toHaveBeenCalledTimes(2)
  } finally { actions.dispose() }
})
