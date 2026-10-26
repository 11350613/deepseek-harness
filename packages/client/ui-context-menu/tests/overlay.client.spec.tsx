// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import { ShortcutRegistry } from '../../shortcuts/src/client/registry.ts'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
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
    <MenuOverlay useCatalog={select => select([])} useStore={useStore} actions={store.actions} close={close} select={run}
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
    { id: 'plain', label: 'Open', icon: <svg data-testid="plugin-icon"><path d="M0 0" /></svg> },
    { id: 'blocked', label: 'Unavailable', disabled: true, danger: true, icon: <img src="data:image/png;base64,AA==" width={14} height={14} alt="" />, separatorBefore: true },
    { id: 'parent', label: 'Export', children: [{ id: 'child', label: 'Original' }, { id: 'other', label: 'Other', separatorBefore: true }] },
    { id: 'footer', label: 'Folder', afterContent: true },
  ])
  const view = render(<MenuOverlay useCatalog={select => select([])} useStore={bindSnapshotSelector(store)} actions={store.actions}
    close={() => { store.actions.close() }} select={select} renderSlot={() => null} />)
  expect(view.getByTestId('plugin-icon').parentElement?.closest('[role="menuitem"]')?.textContent).toContain('Open')
  expect(view.getByRole('menuitem', { name: 'Unavailable' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(view.getByRole('menuitem', { name: 'Open' }))
  expect(select).toHaveBeenCalledWith('plain')
  fireEvent.click(view.getByRole('menuitem', { name: 'Export' }))
  expect(view.getAllByRole('separator')).toHaveLength(2)
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

it('tracks configured shortcuts for nested and footer actions without invoking command dispatch', () => {
  const shortcuts = new ShortcutRegistry('desktop', 'macos')
  const commandId = 'session.rename' as ShortcutCommandId
  const resolveCommand = vi.fn(() => ({ status: 'pass' as const }))
  const remove = shortcuts.register({ id: commandId, label: () => 'Rename', aliases: [],
    defaults: { 'desktop:macos': { code: 'KeyG', modifiers: ['primary', 'alt'] } },
    regions: ['page'], modals: [], resolve: resolveCommand })
  const store = createMenuStore().create()
  store.actions.open({ kind: 'session', value: { sessionId: SessionId('captured'), displayTitle: 'Captured' } }, { x: 30, y: 40 })
  store.actions.items([
    { id: 'rename', label: 'Rename', commandId },
    { id: 'missing', label: 'Unknown command', commandId: 'absent' as ShortcutCommandId },
    { id: 'parent', label: 'Submenu', children: [{ id: 'nested', label: 'Nested', commandId }] },
    { id: 'footer', label: 'Footer', commandId, afterContent: true },
  ])
  const select = vi.fn()
  const view = render(<MenuOverlay useStore={bindSnapshotSelector(store)} actions={store.actions}
    useCatalog={bindSnapshotSelector(shortcuts.catalog)} close={vi.fn()} select={select} renderSlot={() => null} />)
  const item = view.getByRole('menuitem', { name: 'Rename' })
  expect(item.getAttribute('aria-keyshortcuts')).toBe('Alt+Meta+G')
  expect(view.getByRole('menuitem', { name: 'Unknown command' }).getAttribute('aria-keyshortcuts')).toBeNull()
  act(() => { shortcuts.configure({ ...shortcuts.config.getSnapshot(), revision: 'custom' as never,
    document: { schemaVersion: 2, profiles: { 'desktop:macos': { 'session.rename': { code: 'KeyR', modifiers: ['primary', 'shift'] } } } } }) })
  expect(item.getAttribute('aria-keyshortcuts')).toBe('Shift+Meta+R')
  expect(view.getByRole('menuitem', { name: 'Footer' }).getAttribute('aria-keyshortcuts')).toBe('Shift+Meta+R')
  fireEvent.click(view.getByRole('menuitem', { name: 'Submenu' }))
  expect(view.getByRole('menuitem', { name: 'Nested' }).getAttribute('aria-keyshortcuts')).toBe('Shift+Meta+R')
  act(() => { shortcuts.configure({ ...shortcuts.config.getSnapshot(), revision: 'unbound' as never,
    document: { schemaVersion: 2, profiles: { 'desktop:macos': { 'session.rename': null } } } }) })
  expect(item.getAttribute('aria-keyshortcuts')).toBeNull()
  expect(item.querySelector('kbd')).toBeNull()
  act(remove)
  expect(item.getAttribute('aria-keyshortcuts')).toBeNull()
  fireEvent.click(item)
  expect(select).toHaveBeenCalledWith('rename')
  expect(resolveCommand).not.toHaveBeenCalled()
})
