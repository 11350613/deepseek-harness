/** Original content and native file-save operations; raw paths never cross from the renderer. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Native reference to a successfully saved file, valid until the owning application window reloads or closes. */
export type SavedFileId = Branded<'SavedFileId'>
/** Original content; the URL must identify the original, not a resized preview. */
export interface FileActionSource {
  readonly url: string
  /** Read through the resource owner's authorized carrier when the source is not a browser URL. */
  readonly read?: (signal: AbortSignal) => Promise<Blob>
  readonly name?: string
  readonly mediaType?: string
}
/** Result of an explicit save gesture. Cancellation is not a failure. */
export type FileSaveResult = { readonly status: 'cancelled' }
  | { readonly status: 'requested' }
  | { readonly status: 'saved'; readonly fileId?: SavedFileId }
/** Desktop-owned operations exposed only to the trusted application frame. */
export interface DesktopFileActions {
  /**
   * @param request - original bytes and safe suggested filename.
   * @returns saved reference, or cancellation.
   */
  save(this: void, request: { bytes: Uint8Array; name: string; mode: 'download' | 'saveAs' }): Promise<FileSaveResult>
  /**
   * @param url - HTTP(S) original fetched without credentials.
   * @returns original bytes and response MIME.
   */
  readImage(this: void, url: string): Promise<{ bytes: Uint8Array; mediaType: string }>
  /**
   * @param bytes - PNG-encoded clipboard image.
   * @returns after native clipboard accepts the decoded image.
   */
  copyImage(this: void, bytes: Uint8Array): Promise<void>
  /**
   * @param id - reference returned by save.
   * @returns after the file manager accepts the request.
   */
  reveal(this: void, id: SavedFileId): Promise<void>
}
/** UI-independent Client file actions. */
export interface FileActions {
  /**
   * Save original bytes to the selected destination.
   * @param source - original content.
   * @param mode - explicit destination policy.
   * @returns save outcome.
   */
  save(source: FileActionSource, mode: 'download' | 'saveAs'): Promise<FileSaveResult>
  /**
   * Copy a decoded, pasteable image.
   * @param source - encoded original.
   * @returns after a pasteable image is on the clipboard.
   */
  copyImage(source: FileActionSource): Promise<void>
  /**
   * Find the native reference from a previous successful save.
   * @param url - source identity.
   * @returns a known local saved file, otherwise undefined.
   */
  savedFile(url: string): SavedFileId | undefined
  /**
   * Reveal a known saved file in the native file manager.
   * @param id - reference to a successful save.
   * @returns after reveal succeeds.
   */
  reveal(id: SavedFileId): Promise<void>
  /** Whether this browser or native adapter can offer an explicit save picker. */
  readonly canSaveAs: boolean
}
