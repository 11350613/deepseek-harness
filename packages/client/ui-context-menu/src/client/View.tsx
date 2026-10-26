/** Shared Web renderer for Client menu contributions. */
import { Menu, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsStore, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { Shortcuts, ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { createMenuStore } from './store.ts'
import type { MenuActionView } from './types.ts'

/** @param actions - plain presentation. @param catalog - effective user shortcuts. @returns existing Menu entries. */
export function menuEntries(actions: readonly MenuActionView[], catalog: readonly ShortcutCatalogEntry[]): MenuEntry[] {
  return actions.flatMap((action) => {
    const shortcut = catalog.find(entry => entry.id === action.commandId)
    const item: MenuEntry = { id: action.id, label: action.label,
      ...(shortcut === undefined ? {} : { shortcut }),
      ...(action.disabled === undefined ? {} : { disabled: action.disabled }),
      ...(action.danger === undefined ? {} : { danger: action.danger }),
      ...(action.icon === undefined ? {} : { icon: action.icon }),
      ...(action.children === undefined ? {} : { submenu: menuEntries(action.children, catalog) }),
    }
    return action.separatorBefore ? [{ type: 'separator', id: `${action.id}:separator` }, item] : [item]
  })
}

/** Shared overlay callbacks. */
export interface MenuOverlayInjected {
  hooks: { catalog: Shortcuts['catalog'] }
  close: () => void
  returnFocus?: () => HTMLElement | null
  select: (id: string) => void
}
type Props = PropsStore<ReturnType<typeof createMenuStore>>
  & PropsRenderSlots<'contextMenu.content'> & InjectFace<MenuOverlayInjected>

/** @param props - registered state, target-specific legacy rows, and actions. @returns one menu and persistent feedback. */
export function MenuOverlay({ useStore, actions, renderSlot, close, select, returnFocus, useCatalog }: Props) {
  const catalog = useCatalog(value => value)
  const { target, point, items, notice, occurrence, closing, replacing } = useStore(s => s)
  return <>
    <Menu key={occurrence} open={target !== null} anchor={null} portal autoFocus contextual returnFocus={returnFocus}
      exiting={closing ? replacing ? 'replace' : 'dismiss' : undefined}
      getAnchorRect={() => new DOMRect(point.x, point.y, 0, 0)}
      items={menuEntries(items.filter(item => !item.afterContent), catalog)}
      footer={menuEntries(items.filter(item => item.afterContent), catalog)} onClose={close} onSelect={select}>
      {target !== null && renderSlot('contextMenu.content', { target, dismiss: close }, { entryKey: target.kind })}
    </Menu>
    {notice !== null && <Toast key={notice.id} text={notice.text}
      {...notice.success ? { tone: 'success' as const } : {}} onDone={() => { actions.notify(null) }} />}
  </>
}
