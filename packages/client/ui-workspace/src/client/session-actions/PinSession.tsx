/** Session pin hover button over the workspace owner’s shared callbacks. */
import {
  IconPinFillRegular, IconPinOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PinSessionInjected, SessionRowActionProps } from '../contract/slots.ts'
import css from '../rows/Rows.module.css'

type PinState = Pick<SessionRowActionProps<PinSessionInjected>, 'sessionId' | 'usePinned' | 'useArchived' | 'useSessionAccess'>

/** The row's pin and archive membership, one Set lookup each, and whether its access allows the toggle. */
function usePinState({ sessionId, usePinned, useArchived, useSessionAccess }: PinState) {
  const pinned = usePinned(set => set.has(sessionId))
  return {
    pinned,
    archived: useArchived(archived => archived.has(sessionId)),
    allowed: useSessionAccess(sessionId, pinned ? 'workspace/unpinSession' : 'workspace/pinSession'),
  }
}

/**
 * Hover button (order 200, rightmost: it lands where the rest-state pin marker sits); absent on
 * archived rows and while the Session's access snapshot excludes that toggle.
 * @param props - owner share, the access Hook, and the pin share.
 * @returns the button, or null for an archived or refused Session.
 */
export function PinSessionRowButton(props: SessionRowActionProps<PinSessionInjected>) {
  const { sessionId, pinSession, unpinSession, t } = props
  const { pinned, archived, allowed } = usePinState(props)
  if (archived || !allowed) return null
  return (
    <Tooltip label={t(pinned ? 'actions.unpin' : 'actions.pin')} side="bottom" align="end" delayMs={500} portal>
      <button
        type="button"
        className={css.iconButton}
        aria-label={t(pinned ? 'menu.unpinSession' : 'menu.pinSession')}
        onClick={() => { (pinned ? unpinSession : pinSession)(sessionId) }}
      >
        {pinned ? <IconPinFillRegular size={14} /> : <IconPinOutlineRegular size={14} />}
      </button>
    </Tooltip>
  )
}
