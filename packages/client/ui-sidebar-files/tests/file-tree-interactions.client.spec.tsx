// @vitest-environment jsdom
/** Interactive accessories and the lifetime of a file row's real Menu. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { TreeFixture as FileTree } from './tree-fixture.client.tsx'
import type { Accessory } from './tree-fixture.client.tsx'
import type { FileTreeInput, TreeEntry, TreeEntryKind } from '../src/client/FileTree.tsx'

afterEach(() => { cleanup() })

type TestInput = FileTreeInput & { accessory?: Accessory | undefined }

function ActionAccessory({ entry }: { entry: TreeEntry }) {
  return <button onClick={() => { actions.get(entry.path)?.() }}>Action</button>
}
const actions = new Map<string, () => void>()
afterEach(() => { actions.clear() })

const file: TreeEntry = { path: 'pr/src/a', name: 'First.txt', meta: { kind: 'file', size: 1 } }

function draw(overrides: Partial<TestInput> = {}) {
  const onOpen = vi.fn<TestInput['onOpen']>()
  const props: TestInput = { root: 'pr', entries: [file], expanded: ['pr/src'], onOpen, onToggle: vi.fn(), newTab: true, ...overrides }
  const view = render(<FileTree {...props} />)
  return { view, onOpen, rerender: (next: Partial<TestInput>) => { view.rerender(<FileTree {...props} {...next} />) } }
}

it.each<TreeEntryKind>(['file', 'directory', 'other'])('keeps a %s accessory button outside the primary action and its disabled scope', (kind) => {
  const accessory = vi.fn()
  const onToggle = vi.fn()
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const entry = { ...file, meta: { kind } }
    actions.set(entry.path, accessory)
    const onOpen = vi.fn()
    const view = render(<FileTree root="pr/src" entries={[entry]} expanded={[]} onOpen={onOpen} onToggle={onToggle}
      accessory={ActionAccessory} />)
    const action = view.getByRole('button', { name: 'Action' })
    fireEvent.click(action)
    expect(accessory).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
    expect(onToggle).not.toHaveBeenCalled()
    expect(view.container.querySelector('button button')).toBeNull()
    expect(action.closest('[aria-disabled="true"]')).toBeNull()
    expect(diagnostic).not.toHaveBeenCalled()
    if (kind !== 'other') {
      fireEvent.click(view.getByRole('button', { name: file.name }))
      if (kind === 'file') expect(onOpen).toHaveBeenCalledWith(entry, { newTab: false })
      else expect(onToggle).toHaveBeenCalledWith(entry, true)
    }
  } finally {
    diagnostic.mockRestore()
  }
})

it('leaves an accessory enabled when the caller refuses to open its file', () => {
  const accessory = vi.fn()
  actions.set(file.path, accessory)
  const { view, onOpen } = draw({ root: 'pr/src', canOpen: () => false, accessory: ActionAccessory })
  const action = view.getByRole('button', { name: 'Action' })
  expect(action.closest('[aria-disabled="true"]')).toBeNull()
  fireEvent.click(action)
  expect(accessory).toHaveBeenCalledTimes(1)
  expect(onOpen).not.toHaveBeenCalled()
})

it('uses the current entry and callback when the same path refreshes under an open menu', () => {
  const { view, onOpen, rerender } = draw()
  fireEvent.contextMenu(view.getByRole('button', { name: file.name }))
  const latest = { ...file, name: 'Renamed.md', meta: { kind: 'file' as const, hidden: true, size: 2 } }
  const latestOpen = vi.fn()
  rerender({ entries: [{ path: 'pr/src/other', name: 'Other' }, latest], directories: { 'pr/src': { failure: 'Retained listing', truncated: true } }, onOpen: latestOpen })
  expect(view.getByRole('button', { name: latest.name })).toBeTruthy()
  fireEvent.click(view.getByRole('menuitem'))
  expect(onOpen).not.toHaveBeenCalled()
  expect(latestOpen).toHaveBeenCalledWith(latest, { newTab: true })
  expect(latestOpen.mock.calls[0]![0]).toBe(latest)
})

const cancellations: [string, Partial<TestInput>][] = [
  ['deletion', { entries: [] }],
  ['directory kind', { entries: [{ ...file, meta: { kind: 'directory' } }] }],
  ['other kind', { entries: [{ ...file, meta: { kind: 'other' } }] }],
  ['canOpen refusal', { canOpen: () => false }],
  ['newTab removal', { newTab: undefined }],
  ['ancestor collapse', { expanded: [] }],
  ['ancestor loading', { directories: { 'pr/src': { loading: true } } }],
  ['root loading', { directories: { pr: { loading: true } } }],
  ['ancestor kind', { entries: [file, { path: 'pr/src', name: 'src', meta: { kind: 'file' } }] }],
  ['root change', { root: 'elsewhere' }],
]

it.each(cancellations)('ends the menu on %s without executing, refocusing, or reviving it', (_name, change) => {
  const { view, onOpen, rerender } = draw()
  const button = view.getByRole('button', { name: file.name })
  fireEvent.contextMenu(button)
  const oldItem = view.getByRole('menuitem')
  const focus = vi.spyOn(button, 'focus')
  try {
    rerender(change)
    expect(view.queryByRole('menuitem')).toBeNull()
    fireEvent.click(oldItem)
    expect(onOpen).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    rerender({})
    expect(view.queryByRole('menuitem')).toBeNull()
    fireEvent.contextMenu(view.getByRole('button', { name: file.name }))
    fireEvent.click(view.getByRole('menuitem'))
    expect(onOpen).toHaveBeenCalledWith(file, { newTab: true })
  } finally {
    focus.mockRestore()
  }
})

it.each(['selection', 'Escape'])('does not refocus a detached anchor on %s', (close) => {
  const { view, onOpen } = draw()
  const button = view.getByRole('button', { name: file.name })
  fireEvent.contextMenu(button)
  const item = view.getByRole('menuitem')
  const focus = vi.spyOn(button, 'focus')
  view.container.remove()
  try {
    if (close === 'selection') fireEvent.click(item)
    else fireEvent.keyDown(item, { key: 'Escape' })
    expect(view.queryByRole('menuitem')).toBeNull()
    expect(focus).not.toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
  } finally {
    focus.mockRestore()
    document.body.appendChild(view.container)
  }
})

it('returns focus for Shift+Tab but leaves iframe focus alone, and does not focus on unmount', () => {
  const { view, onOpen } = draw()
  const button = view.getByRole('button', { name: file.name })
  fireEvent.contextMenu(button)
  fireEvent.keyDown(view.getByRole('menuitem'), { key: 'Tab', shiftKey: true })
  expect(view.queryByRole('menuitem')).toBeNull()
  expect(document.activeElement).toBe(button)
  const frame = document.body.appendChild(document.createElement('iframe'))
  const focus = vi.spyOn(button, 'focus')
  try {
    fireEvent.contextMenu(button)
    frame.focus()
    fireEvent.blur(window)
    expect(view.queryByRole('menuitem')).toBeNull()
    expect(document.activeElement).toBe(frame)
    fireEvent.contextMenu(button)
    view.unmount()
    expect(focus).not.toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
  } finally {
    focus.mockRestore()
    frame.remove()
  }
})
