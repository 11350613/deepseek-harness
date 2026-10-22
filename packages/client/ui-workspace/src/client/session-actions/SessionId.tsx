/** Copy the row's Session ID without opening its history. */
import { IconCopyOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionIdInjected, SessionMenuItemProps } from '../contract/slots.ts'

/**
 * Copy the complete ID after dismissing the row menu.
 * @param props - Row identity, menu dismissal, clipboard action, and locale.
 * @returns The copy action at the start of the identification group.
 */
export function SessionIdMenuItem({ sessionId, useMenuOpenState, copySessionId, t }: SessionMenuItemProps<SessionIdInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton separatorBefore icon={<IconCopyOutlineRegular />} onSelect={() => {
      setMenuOpen(false)
      void copySessionId(sessionId)
    }}>
      {t('menu.sessionId')}
    </MenuItemButton>
  )
}
