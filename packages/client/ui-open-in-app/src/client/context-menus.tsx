/** Native path and URL menu contributions, independent of their trigger components. */
import { IconFolderOpenOutlineRegular, IconCopyOutlineRegular, IconPanelLeftOutlineRegular, IconRightUpOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-browser/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { OpenInAppController } from './controller.ts'
import { fileAddressFor, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import type { OpenInAppPathController } from './open-path.ts'
import type { OpenInAppKey } from './locales.ts'

/**
 * Register native opening, original-path reveal, and URL actions.
 * @param ctx - declared plugin dependencies.
 * @param paths - existing native file actions.
 * @param t - localized action labels.
 * @param directories - installed directory applications.
 */
export function registerContextMenus(
  ctx: Context,
  paths: OpenInAppPathController,
  t: (key: OpenInAppKey, values?: Record<string, string>) => string,
  directories: OpenInAppController,
): void {
  const fileManager = () => t(directories.apps.getSnapshot()?.includes('finder') ? 'menu.finder' : 'menu.reveal')
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
      return [{ id: 'reveal', icon: <IconFolderOpenOutlineRegular />, label: fileManager(), disabled: manager === undefined,
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
        { id: 'reveal', icon: <IconFolderOpenOutlineRegular />, label: fileManager(), disabled: paths.desktop.getSnapshot() !== true,
          run: () => open(absolutePath, 'reveal') },
        { id: 'copyPath', icon: <IconCopyOutlineRegular />, label: t('menu.copyDirectoryPath'), failureLabel: t('menu.copyFailed'), run: async () => {
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
      return [
        { id: 'sidebar', icon: <IconPanelLeftOutlineRegular />, label: t('menu.sidebar'), disabled: !available,
          run: () => {
            const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
            ctx.sidebarRight.openResourceIn(sessionId, fileAddressFor(sessionId, cwd, path), {
              ...(paneId === undefined ? {} : { paneId }), ...(line === undefined ? {} : { params: { line } }),
            })
          } },
        { id: 'reveal', icon: <IconFolderOpenOutlineRegular />, label: fileManager(), disabled: !desktop,
          ...absolutePath === undefined ? {} : { run: () => open(absolutePath, 'reveal') } },
        { id: 'open', label: application ? t('open.title', { app: application.name }) : t('menu.defaultApp'),
          icon: application?.icon ? <img src={application.icon} width={14} height={14} alt="" /> : <IconRightUpOutlineRegular />, disabled: application === undefined,
          ...absolutePath === undefined || application === undefined ? {} : { run: () => open(absolutePath, 'open', application.id) } },
        { id: 'copyPath', icon: <IconCopyOutlineRegular />, failureLabel: t('menu.copyFailed'), label: t('menu.copyPath'),
          run: async () => {
            const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
            await navigator.clipboard.writeText(absolutePath ?? resolveWorkspacePath(cwd, path))
            ctx.menus.notify(t('menu.copied'), true)
          } },
      ]
    },
  }), 'open-in-app: file context menu')
  ctx.effect(() => ctx.menus.register({
    id: 'open-in-app.url', target: 'url', order: 100,
    resolve: ({ sessionId, url }) => [
      { id: 'sidebar', icon: <IconPanelLeftOutlineRegular />, label: t('menu.sidebar'), disabled: ctx.sidebarRightTabs.get('browser') === undefined,
        run: () => { ctx.sidebarRight.openTabIn(sessionId, 'browser', { params: { url } }) } },
      { id: 'external', label: t('menu.external'),
        run: () => { window.open(url, '_blank', 'noopener,noreferrer') } },
      { id: 'copy', icon: <IconCopyOutlineRegular />, failureLabel: t('menu.copyFailed'), label: t('menu.copyLink'), run: async () => {
        await navigator.clipboard.writeText(url); ctx.menus.notify(t('menu.copied'), true)
      } },
    ],
  }), 'open-in-app: URL context menu')
  ctx.effect(() => ctx.menus.register({
    id: 'open-in-app.image', target: 'image', order: 200,
    resolve: async (target, signal) => {
      const { sessionId, path } = target
      await paths.load()
      const local = path !== undefined && sessionId !== undefined && paths.desktop.getSnapshot() === true
        ? await resolvePath(sessionId, path, signal) : undefined
      signal.throwIfAborted()
      return [
        { id: 'reveal', icon: <IconFolderOpenOutlineRegular />, label: fileManager(), disabled: local === undefined,
          ...local !== undefined ? { run: () => open(local, 'reveal') } : {} },
      ]
    },
  }), 'open-in-app: image context menu')
}
