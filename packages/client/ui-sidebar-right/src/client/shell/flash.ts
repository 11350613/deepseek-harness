/** The outline a reveal draws once around the pane holding the revealed tab; the stylesheet owns its animation. */
import type { SidebarRightFlash } from '../service.ts'

/**
 * Mark the pane a flash request names, docked or floating, until its animation ends.
 * @param root - the Session's panel, which contains its docked and floating panes.
 * @param flash - the latest request; alternating serials select alternating keyframes, so a repeat restarts.
 * @returns the cleanup that removes the mark, or undefined when no pane was marked.
 */
export function flashPane(root: HTMLElement | null, flash: SidebarRightFlash | undefined): (() => void) | undefined {
  if (root === null || flash === undefined) return undefined
  const pane = root.querySelector<HTMLElement>(`[data-dockkit-pane="${flash.paneId}"], [data-dockkit-float="${flash.paneId}"]`)
  if (pane === null) return undefined
  const end = (event: AnimationEvent): void => { if (event.target === pane) clear() }
  const clear = (): void => {
    pane.removeEventListener('animationend', end)
    pane.removeEventListener('animationcancel', end)
    delete pane.dataset.sidebarRightFlash
  }
  pane.dataset.sidebarRightFlash = flash.serial % 2 === 0 ? 'even' : 'odd'
  pane.addEventListener('animationend', end)
  pane.addEventListener('animationcancel', end)
  return clear
}
