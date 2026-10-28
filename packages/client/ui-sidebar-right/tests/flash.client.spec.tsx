// @vitest-environment jsdom
/** The outline a reveal draws around the revealed tab's pane. */
import { afterEach, expect, it } from 'vitest'
import { act, fireEvent } from '@testing-library/react'
import type { PaneId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { flashPane } from '../src/client/shell/flash.ts'

afterEach(() => { document.body.replaceChildren() })

it('marks the named docked or floating pane until its own animation ends', () => {
  document.body.innerHTML = '<div id="root"><section data-dockkit-pane="pane1"><p></p></section><section data-dockkit-float="pane2"></section></div>'
  const root = document.getElementById('root')!
  const docked = root.querySelector<HTMLElement>('[data-dockkit-pane]')!
  flashPane(root, { paneId: 'pane1' as PaneId, serial: 1 })
  expect(docked.dataset.sidebarRightFlash).toBe('odd')
  // A child's animation is not the outline's.
  fireEvent.animationEnd(docked.querySelector('p')!)
  expect(docked.dataset.sidebarRightFlash).toBe('odd')
  fireEvent.animationEnd(docked)
  expect(docked.dataset.sidebarRightFlash).toBeUndefined()
  const floating = root.querySelector<HTMLElement>('[data-dockkit-float]')!
  flashPane(root, { paneId: 'pane2' as PaneId, serial: 2 })
  expect(floating.dataset.sidebarRightFlash).toBe('even')
  act(() => { floating.dispatchEvent(new Event('animationcancel')) })
  expect(floating.dataset.sidebarRightFlash).toBeUndefined()
  // The cleanup removes the mark at once, as the seat does before the next request.
  const clear = flashPane(root, { paneId: 'pane2' as PaneId, serial: 3 })!
  expect(floating.dataset.sidebarRightFlash).toBe('odd')
  clear()
  expect(floating.dataset.sidebarRightFlash).toBeUndefined()
})

it('marks nothing without a panel, a request, or the named pane', () => {
  document.body.innerHTML = '<div id="root"></div>'
  const root = document.getElementById('root')!
  expect(flashPane(null, { paneId: 'pane1' as PaneId, serial: 1 })).toBeUndefined()
  expect(flashPane(root, undefined)).toBeUndefined()
  expect(flashPane(root, { paneId: 'pane1' as PaneId, serial: 1 })).toBeUndefined()
})
