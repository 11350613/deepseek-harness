// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Menu, MenuItemButton } from '../src/Menu.tsx'

afterEach(() => { cleanup(); document.documentElement.style.removeProperty('--dsh-frame-top-clearance') })

it('places pointer menus at the cursor above the frame inset and focuses after portal placement', async () => {
  document.documentElement.style.setProperty('--dsh-frame-top-clearance', '96px')
  const close = vi.fn()
  const view = render(<Menu open portal autoFocus contextual anchor={null} onClose={close}
    getAnchorRect={() => new DOMRect(200, 20, 0, 0)} items={[{ id: 'copy', label: 'Copy' }]} />)
  const menu = view.getByRole('menu')
  expect(menu.style.top).toBe('24px')
  await waitFor(() => { expect(document.activeElement).toBe(view.getByRole('menuitem')) })
  fireEvent.pointerDown(document.body, { button: 2 })
  expect(close).not.toHaveBeenCalled()
  fireEvent.pointerDown(document.body, { button: 0 })
  expect(close).toHaveBeenCalledOnce()
})

it('groups data icons per divider, preserves component rows, and makes exit frames inert', () => {
  const props = { open: true, portal: true, contextual: true, anchor: null, onClose: vi.fn(),
    items: [{ id: 'first', label: 'First', icon: <svg /> }, { id: 'second', label: 'Second' },
      { type: 'separator' as const, id: 'split' }, { id: 'third', label: 'Third' }] }
  const view = render(<Menu {...props}><MenuItemButton onSelect={() => {}}>Plugin</MenuItemButton></Menu>)
  expect(view.getByRole('menuitem', { name: 'First' }).hasAttribute('data-menu-icon-space')).toBe(true)
  expect(view.getByRole('menuitem', { name: 'Second' }).hasAttribute('data-menu-icon-space')).toBe(true)
  expect(view.getByRole('menuitem', { name: 'Third' }).hasAttribute('data-menu-icon-space')).toBe(false)
  expect(view.getByRole('menuitem', { name: 'Plugin' }).hasAttribute('data-menu-icon-space')).toBe(false)
  view.rerender(<Menu {...props} exiting="replace" />)
  expect(view.queryByRole('menu')).toBeNull()
  expect(document.querySelector('[data-menu-phase="replace"]')).not.toBeNull()
})
