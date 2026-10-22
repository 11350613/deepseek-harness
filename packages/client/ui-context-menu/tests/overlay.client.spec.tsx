// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { createMenuStore } from '../src/client/store.ts'
import { MenuOverlay } from '../src/client/View.tsx'
import type { MenuTarget } from '../src/client/types.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

it('renders legacy Session actions before data contributions and restores More focus after dismissal', async () => {
  const store = createMenuStore().create(), run = vi.fn()
  const close = () => { store.actions.close() }
  const useStore = bindSnapshotSelector(store)
  const view = render(<>
    <button onClick={() => { store.actions.open({ kind: 'session', value: { sessionId: SessionId('clicked'), displayTitle: 'Clicked' } }, { x: 20, y: 30 }) }}>More</button>
    <MenuOverlay useStore={useStore} actions={store.actions} close={close} select={run}
      renderSlot={(_key, owner: object) => {
        const { target, dismiss } = owner as { target: MenuTarget; dismiss: () => void }
        return <MenuItemButton onSelect={() => {
          if (target.kind === 'session') run(target.value.sessionId)
          dismiss()
        }}>Export</MenuItemButton>
      }} />
  </>)
  const trigger = view.getByRole('button', { name: 'More' })
  trigger.focus(); fireEvent.click(trigger)
  await waitFor(() =>{  expect(view.getByRole('menuitem', { name: 'Export' })).toBe(document.activeElement) })
  fireEvent.click(view.getByRole('menuitem', { name: 'Export' }))
  await waitFor(() =>{  expect(document.activeElement).toBe(trigger) })
  expect(run).toHaveBeenCalledExactlyOnceWith('clicked')
  expect(view.queryByRole('menu')).toBeNull()
  fireEvent.click(trigger)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(view.queryByRole('menu')).toBeNull()
  fireEvent.click(trigger)
  fireEvent.pointerDown(document.body)
  expect(view.queryByRole('menu')).toBeNull()
})

it('renders disabled, grouped and nested data actions and keeps feedback after menu dismissal', () => {
  vi.useFakeTimers()
  const store = createMenuStore().create(), select = vi.fn()
  store.actions.open({ kind: 'session', value: { sessionId: SessionId('clicked'), displayTitle: 'Clicked' } }, { x: 20, y: 30 })
  store.actions.items([
    { id: 'plain', label: 'Open', symbol: 'external' },
    { id: 'blocked', label: 'Unavailable', disabled: true, danger: true, icon: 'data:image/png;base64,AA==', separatorBefore: true },
    { id: 'parent', label: 'Export', children: [{ id: 'child', label: 'Original' }, { id: 'other', label: 'Other', separatorBefore: true }] },
    { id: 'footer', label: 'Folder', afterContent: true },
  ])
  const view = render(<MenuOverlay useStore={bindSnapshotSelector(store)} actions={store.actions}
    close={() => { store.actions.close() }} select={select} renderSlot={() => null} />)
  expect(view.getByRole('menuitem', { name: 'Unavailable' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(view.getByRole('menuitem', { name: 'Open' }))
  expect(select).toHaveBeenCalledWith('plain')
  fireEvent.click(view.getByRole('menuitem', { name: 'Export' }))
  fireEvent.click(view.getByRole('menuitem', { name: 'Original' }))
  expect(select).toHaveBeenCalledWith('child')
  act(() => { store.actions.exit(true) })
  expect(document.querySelector('[data-menu-phase="replace"]')).not.toBeNull()
  act(() => { store.actions.exit(false) })
  expect(document.querySelector('[data-menu-phase="dismiss"]')).not.toBeNull()
  act(() => { store.actions.close(); store.actions.notify({ id: 1, text: 'Copied', success: true }) })
  expect(view.queryByRole('menu')).toBeNull()
  expect(view.getByRole('alert').textContent).toBe('Copied')
  act(() => { store.actions.notify({ id: 2, text: 'Copy failed', success: false }) })
  expect(view.getByRole('alert').textContent).toBe('Copy failed')
  act(() => { vi.advanceTimersByTime(4000) })
  expect(view.queryByRole('alert')).toBeNull()
})
