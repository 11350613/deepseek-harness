/** Native path and original-image menu contributions, independent of their trigger components. */
import mime from 'mime'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-file-actions/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-browser/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FileActionSource } from '@deepseek-ai/dsh-client-ui-file-actions/client'
import type { OpenInAppController } from './controller.ts'
import { fileAddressFor, fileMediaUrl, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import type { OpenInAppPathController } from './open-path.ts'
import type { OpenInAppKey } from './locales.ts'

/**
 * Register native path and original content actions.
 * @param ctx - declared plugin dependencies.
 * @param paths - existing native file actions.
 * @param t - localized action labels.
 * @param directories - installed directory applications.
 */
export function registerContextMenus(ctx: Context, paths: OpenInAppPathController,
  t: (key: OpenInAppKey, values?: Record<string, string>) => string, directories: OpenInAppController): void {
  const fileManager = () => t(directories.apps.getSnapshot()?.includes('finder') ? 'menu.finder' : 'menu.reveal')
  const save = async (source: FileActionSource, mode: 'download' | 'saveAs'): Promise<void> => {
    const result = await ctx.fileActions.save(source, mode)
    if (result.status !== 'cancelled') ctx.menus.notify(t(result.status === 'requested'
      ? 'menu.downloadStarted' : mode === 'download' ? 'menu.downloaded' : 'menu.saved'), true)
  }
  const open = async (path: string, action: 'open' | 'reveal', application?: string): Promise<void> => {
    const failure = await paths.openPath(path, action, application)
    if (failure !== null) ctx.menus.notify(t(`path.${failure}`))
  }
  const resolvePath = async (sessionId: SessionId, path: string, signal: AbortSignal): Promise<string | undefined> => {
    try {
      const result = await ctx.remote.workspaceFiles.stat(sessionId, path, signal)
      return result.ok ? result.value.absolutePath : undefined
    }
    catch (_error) {
      // An unavailable metadata carrier disables path actions; URL and clipboard actions remain independent.
      signal.throwIfAborted()
      return undefined
    }
  }
  ctx.effect(() => ctx.menus.register({
    id: 'open-in-app.workspace', target: 'workspace', order: 200,
    resolve: async ({ path }, signal) => {
      await directories.load()
      signal.throwIfAborted()
      const manager = directories.apps.getSnapshot()?.find(id => ['finder', 'explorer', 'filemanager'].includes(id))
      return [{ id: 'reveal', symbol: 'folder', label: fileManager(), disabled: manager === undefined,
        failureLabel: t('path.revealError'),
        ...manager === undefined ? {} : { run: () => directories.launch(manager, path) } }]
    },
  }), 'open-in-app: Workspace context menu')
  ctx.effect(() => ctx.menus.register({
    id: 'open-in-app.directory', target: 'directory', order: 100,
    resolve: async ({ sessionId, path }, signal) => {
      await paths.load()
      const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
      const absolutePath = resolveWorkspacePath(cwd, path)
      signal.throwIfAborted()
      return [
        { id: 'reveal', symbol: 'folder', label: fileManager(), disabled: paths.desktop.getSnapshot() !== true,
          run: () => open(absolutePath, 'reveal') },
        { id: 'copyPath', symbol: 'copy', label: t('menu.copyDirectoryPath'), failureLabel: t('menu.copyFailed'), run: async () => {
          await navigator.clipboard.writeText(absolutePath)
          ctx.menus.notify(t('menu.copied'), true)
        } },
      ]
    },
  }), 'open-in-app: directory context menu')
  ctx.effect(() => ctx.menus.register({
    id: 'open-in-app.file', target: 'file', order: 100,
    resolve: async (target, signal) => {
      const { sessionId, path, line, paneId } = target
      await paths.load()
      const absolutePath = await resolvePath(sessionId, path, signal)
      const available = absolutePath !== undefined
      const desktop = paths.desktop.getSnapshot() === true && available
      const apps = desktop ? await paths.applications(absolutePath, signal) : []
      signal.throwIfAborted()
      const application = apps?.find(app => app.default)
      const url = fileMediaUrl(document.baseURI, absolutePath ?? path)
      const mediaType = mime.getType(path) ?? ''
      const source: FileActionSource = { url: url ?? path, name: path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1), mediaType,
        read: async (signal) => {
          const result = await ctx.remote.workspaceFiles.readBytes(sessionId, path, {}, signal)
          if (!result.ok) throw new Error('Original file unavailable')
          return new Blob([new Uint8Array(result.value.data)], { type: mediaType })
        },
      }
      return [
        { id: 'sidebar', symbol: 'sidebar', label: t('menu.sidebar'), disabled: !available,
          run: () => {
            const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
            ctx.sidebarRight.openResourceIn(sessionId, fileAddressFor(sessionId, cwd, path), {
              ...(paneId === undefined ? {} : { paneId }), ...(line === undefined ? {} : { params: { line } }),
            })
          } },
        { id: 'reveal', symbol: 'folder', label: fileManager(), disabled: !desktop,
          ...absolutePath === undefined ? {} : { run: () => open(absolutePath, 'reveal') } },
        { id: 'open', symbol: 'external', label: application ? t('open.title', { app: application.name }) : t('menu.defaultApp'),
          ...(application?.icon ? { icon: application.icon } : {}), disabled: application === undefined,
          ...absolutePath === undefined || application === undefined ? {} : { run: () => open(absolutePath, 'open', application.id) } },
        { id: 'copyPath', symbol: 'copy', failureLabel: t('menu.copyFailed'), label: t('menu.copyPath'),
          run: async () => {
            const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
            await navigator.clipboard.writeText(absolutePath ?? resolveWorkspacePath(cwd, path))
            ctx.menus.notify(t('menu.copied'), true)
          } },
        ...mediaType.startsWith('image/') ? [
          { id: 'copyImage', symbol: 'copy' as const, separatorBefore: true, failureLabel: t('menu.copyFailed'), label: t('menu.copyImage'), disabled: !available,
            run: async () => { await ctx.fileActions.copyImage(source); ctx.menus.notify(t('menu.copied'), true) } },
          { id: 'download', symbol: 'download' as const, failureLabel: t('menu.saveFailed'), label: t('menu.download'), disabled: !available,
            run: () => save(source, 'download') },
        ] : [],
        { id: 'saveAs', symbol: 'save', failureLabel: t('menu.saveFailed'), label: t('menu.saveAs'), disabled: !available || !ctx.fileActions.canSaveAs,
          run: () => save(source, 'saveAs') },
      ]
    },
  }), 'open-in-app: file context menu')
  ctx.effect(() => ctx.menus.register({
    id: 'open-in-app.url', target: 'url', order: 100,
    resolve: ({ sessionId, url }) => [
      { id: 'sidebar', symbol: 'sidebar', label: t('menu.sidebar'), disabled: ctx.sidebarRightTabs.get('browser') === undefined,
        run: () => { ctx.sidebarRight.openTabIn(sessionId, 'browser', { params: { url } }) } },
      { id: 'external', symbol: 'external', label: t('menu.external'),
        run: () => { window.open(url, '_blank', 'noopener,noreferrer') } },
      { id: 'copy', symbol: 'copy', failureLabel: t('menu.copyFailed'), label: t('menu.copyLink'), run: async () => {
        await navigator.clipboard.writeText(url); ctx.menus.notify(t('menu.copied'), true)
      } },
    ],
  }), 'open-in-app: URL context menu')
  ctx.effect(() => ctx.menus.register({
    id: 'open-in-app.image', target: 'image', order: 100,
    resolve: async (target, signal) => {
      const { sessionId, path } = target
      const name = target.name ?? target.path?.split(/[\\/]/u).pop()
      const mediaType = target.mediaType || mime.getType(name ?? target.url) || undefined
      const source: FileActionSource = { ...target, ...(name === undefined ? {} : { name }),
        ...(mediaType === undefined ? {} : { mediaType }),
        ...(path === undefined || sessionId === undefined ? {} : { read: async (signal: AbortSignal) => {
          const result = await ctx.remote.workspaceFiles.readBytes(sessionId, path, {}, signal)
          if (!result.ok) throw new Error('Original image unavailable')
          return new Blob([new Uint8Array(result.value.data)], { type: mediaType ?? '' })
        } }),
      }
      await paths.load()
      const saved = ctx.fileActions.savedFile(source.url)
      const local = target.path !== undefined && target.sessionId !== undefined && paths.desktop.getSnapshot() === true
        ? await resolvePath(target.sessionId, target.path, signal) : undefined
      signal.throwIfAborted()
      return [
        { id: 'copy', symbol: 'copy', failureLabel: t('menu.copyFailed'), label: t('menu.copyImage'), run: async () => {
          await ctx.fileActions.copyImage(source); ctx.menus.notify(t('menu.copied'), true)
        } },
        { id: 'download', symbol: 'download', failureLabel: t('menu.saveFailed'), label: t('menu.download'), run: () => save(source, 'download') },
        { id: 'saveAs', symbol: 'save', failureLabel: t('menu.saveFailed'), label: t('menu.saveAs'), disabled: !ctx.fileActions.canSaveAs,
          run: () => save(source, 'saveAs') },
        { id: 'reveal', symbol: 'folder', label: fileManager(), disabled: !local && saved === undefined,
          ...saved !== undefined ? { run: () => ctx.fileActions.reveal(saved) } : local !== undefined ? { run: () => open(local, 'reveal') } : {} },
      ]
    },
  }), 'open-in-app: image context menu')
}
