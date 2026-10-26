/** Original-file menu contributions owned by the file-action capability. */
import { IconCopyOutlineRegular, IconDownloadOutlineRegular, IconSaveOutlineRegular, IconFolderOpenOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FileActions, FileActionSource } from '../types.ts'
import { fileMediaUrl } from '@deepseek-ai/dsh-util-workspace-path'
import mime from 'mime'
import type { FileActionKey } from './locales.ts'

/**
 * Register original-byte operations without requiring an application-opening plugin.
 * @param ctx - menu and authorized file-read services.
 * @param actions - file-action owner.
 * @param t - localized labels and feedback.
 */
export function registerFileMenus(ctx: Context, actions: FileActions, t: (key: FileActionKey) => string): void {
  const read = (sessionId: SessionId, path: string, mediaType: string, error: string) => async (signal: AbortSignal): Promise<Blob> => {
    const result = await ctx.remote.workspaceFiles.readBytes(sessionId, path, {}, signal)
    if (!result.ok) throw new Error(error)
    return new Blob([new Uint8Array(result.value.data)], { type: mediaType })
  }
  const save = async (source: FileActionSource, mode: 'download' | 'saveAs'): Promise<void> => {
    const result = await actions.save(source, mode)
    if (result.status !== 'cancelled') ctx.menus.notify(t(result.status === 'requested'
      ? 'menu.downloadStarted' : mode === 'download' ? 'menu.downloaded' : 'menu.saved'), true)
  }
  const copy = async (source: FileActionSource): Promise<void> => {
    await actions.copyImage(source)
    ctx.menus.notify(t('menu.copied'), true)
  }
  ctx.effect(() => ctx.menus.register({
    id: 'file-actions.file', target: 'file', order: 200,
    resolve: async ({ sessionId, path }, signal) => {
      let absolutePath: string | undefined
      try {
        const result = await ctx.remote.workspaceFiles.stat(sessionId, path, signal)
        absolutePath = result.ok ? result.value.absolutePath : undefined
      } catch (_error) {
        // Failed metadata disables operations that require the source file.
        signal.throwIfAborted()
      }
      signal.throwIfAborted()
      const available = absolutePath !== undefined
      const mediaType = mime.getType(path) ?? ''
      const source: FileActionSource = {
        url: fileMediaUrl(document.baseURI, absolutePath ?? path) ?? path,
        name: path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1),
        mediaType,
        read: read(sessionId, path, mediaType, 'Original file unavailable'),
      }
      return [
        ...mediaType.startsWith('image/') ? [
          { id: 'copyImage', icon: <IconCopyOutlineRegular />, separatorBefore: true, failureLabel: t('menu.copyFailed'),
            label: t('menu.copyImage'), disabled: !available, run: () => copy(source) },
        ] : [],
        ...mediaType.startsWith('image/') || !actions.canSaveAs ? [
          { id: 'download', icon: <IconDownloadOutlineRegular />, failureLabel: t('menu.saveFailed'),
            label: t('menu.download'), disabled: !available, run: () => save(source, 'download') },
        ] : [],
        ...actions.canSaveAs ? [
          { id: 'saveAs', icon: <IconSaveOutlineRegular />, failureLabel: t('menu.saveFailed'), label: t('menu.saveAs'),
            disabled: !available, run: () => save(source, 'saveAs') },
        ] : [],
      ]
    },
  }), 'file actions: file menu')
  ctx.effect(() => ctx.menus.register({
    id: 'file-actions.image', target: 'image', order: 100,
    resolve: (target) => {
      const { sessionId, path } = target
      const name = target.name ?? path?.split(/[\\/]/u).pop()
      const mediaType = target.mediaType || mime.getType(name ?? target.url) || undefined
      const source: FileActionSource = {
        ...target,
        ...(name === undefined ? {} : { name }),
        ...(mediaType === undefined ? {} : { mediaType }),
        ...(path === undefined || sessionId === undefined ? {} : {
          read: read(sessionId, path, mediaType ?? '', 'Original image unavailable'),
        }),
      }
      const saved = actions.savedFile(source.url)
      return [
        { id: 'copy', icon: <IconCopyOutlineRegular />, failureLabel: t('menu.copyFailed'), label: t('menu.copyImage'), run: () => copy(source) },
        { id: 'download', icon: <IconDownloadOutlineRegular />, failureLabel: t('menu.saveFailed'), label: t('menu.download'), run: () => save(source, 'download') },
        ...actions.canSaveAs ? [
          { id: 'saveAs', icon: <IconSaveOutlineRegular />, failureLabel: t('menu.saveFailed'), label: t('menu.saveAs'),
            run: () => save(source, 'saveAs') },
        ] : [],
        ...saved === undefined ? [] : [{
          id: 'reveal', icon: <IconFolderOpenOutlineRegular />,
          label: t(document.documentElement.dataset.platform === 'darwin' ? 'menu.finder' : 'menu.reveal'),
          failureLabel: t('path.revealError'), run: () => actions.reveal(saved),
        }],
      ]
    },
  }), 'file actions: image menu')
}
