/** Native directory reveal in the shared Session action list. */
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { IconFolderOpenOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OpenInAppKey } from './locales.ts'

/** Installed directory applications and a launch callback that reports failures through a toast. */
export interface SessionRevealInjected {
  hooks: { directoryApps: ObservableSnapshot<readonly string[] | null> }
  reveal: (application: string, directory: string) => Promise<void>
}

type Props = Pick<PropsRuntime<'sidebar.workspaces.session.menu.item'>, 'sessionId' | 'useSessions' | 'useMenuOpenState'> & PropsLocale<'open-in-app'> & InjectFace<SessionRevealInjected>

/**
 * Reveal the captured Session directory without changing the selected Session.
 * @param props - Session identity, availability, localized labels, and native launch.
 * @returns The directory action between copy ID and archive.
 */
export function SessionRevealMenuItem({ sessionId, useSessions, useMenuOpenState, useDirectoryApps, reveal, t }: Props) {
  const directory = useSessions(state => state.byId[sessionId]?.cwd)
  const applications = useDirectoryApps(value => value)
  const manager = applications?.find(id => ['finder', 'explorer', 'filemanager'].includes(id))
  const [, setMenuOpen] = useMenuOpenState()
  const label: OpenInAppKey = applications?.includes('finder') ? 'menu.finder' : 'menu.reveal'
  return <MenuItemButton icon={<IconFolderOpenOutlineRegular />} disabled={!directory || manager === undefined}
    onSelect={() => {
      /* v8 ignore next -- the native menu button cannot activate without a directory and file manager. */
      if (!directory || manager === undefined) return
      setMenuOpen(false)
      void reveal(manager, directory)
    }}>{t(label)}</MenuItemButton>
}
