// @vitest-environment jsdom
/** Focus traversal through visible rows and their own action controls. */
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TreeRows } from '../src/client/rows/TreeRows.tsx'

afterEach(cleanup)

function list(keys: readonly string[], selected?: string) {
  return <TreeRows className="rows" label="Sessions">
    {keys.map(key => <div key={key} role="treeitem" tabIndex={-1} aria-selected={key === selected}>
      {key}<button>{key} actions</button><button tabIndex={-1}>{key} secondary</button>
    </div>)}
  </TreeRows>
}

it('keeps one entry and only that row’s actions in the Tab order', () => {
  render(list(['one', 'two', 'three'], 'two'))
  const rows = screen.getAllByRole('treeitem')
  expect(rows.map(row => row.tabIndex)).toEqual([-1, 0, -1])
  expect(screen.getAllByRole('button').map(button => button.tabIndex)).toEqual([-1, -1, 0, -1, -1, -1])
  rows[0]!.focus()
  expect(rows.map(row => row.tabIndex)).toEqual([0, -1, -1])
  expect(screen.getByRole('button', { name: 'one actions' }).tabIndex).toBe(0)
  screen.getByRole('button', { name: 'three actions' }).focus()
  expect(rows.map(row => row.tabIndex)).toEqual([-1, -1, 0])
})

it('walks rows without opening them and clamps at both ends', () => {
  render(list(['one', 'two', 'three']))
  const rows = screen.getAllByRole('treeitem')
  rows[0]!.focus()
  for (const [key, index] of [['ArrowUp', 0], ['ArrowDown', 1], ['ArrowLeft', 1], ['End', 2], ['ArrowDown', 2], ['Home', 0]] as const) {
    fireEvent.keyDown(document.activeElement!, { key })
    expect(document.activeElement).toBe(rows[index])
    expect(rows.map(row => row.tabIndex)).toEqual(rows.map((_, i) => i === index ? 0 : -1))
  }
  const button = screen.getByRole('button', { name: 'one actions' })
  button.focus()
  expect(fireEvent.keyDown(button, { key: 'ArrowDown' })).toBe(true)
  expect(document.activeElement).toBe(button)
  rows[0]!.focus()
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
    expect(fireEvent.keyDown(rows[0]!, { key: 'ArrowDown', [modifier]: true })).toBe(true)
    expect(document.activeElement).toBe(rows[0])
  }
  expect(fireEvent.keyDown(rows[0]!, { key: 'Escape' })).toBe(true)
})

it('retains the entry across reorder and chooses a surviving row after removal', () => {
  const view = render(list(['one', 'two']))
  screen.getAllByRole('treeitem')[1]!.focus()
  view.rerender(list(['two', 'one', 'three']))
  expect(screen.getAllByRole('treeitem').map(row => row.tabIndex)).toEqual([0, -1, -1])
  view.rerender(list(['one', 'three']))
  expect(screen.getAllByRole('treeitem').map(row => row.tabIndex)).toEqual([0, -1])
  view.rerender(list([]))
  screen.getByRole('tree').focus()
  expect(fireEvent.keyDown(screen.getByRole('tree'), { key: 'Home' })).toBe(true)
})

it('expands, enters, returns to, and collapses a folder with horizontal arrows', () => {
  const toggle = vi.fn()
  function Folder() {
    const [expanded, setExpanded] = useState(false)
    return <TreeRows className="rows" label="Folders">
      <div role="treeitem" aria-level={1} aria-expanded={expanded} tabIndex={-1}
        onClick={() => { toggle(); setExpanded(!expanded) }}>folder</div>
      {expanded && <div role="treeitem" aria-level={2} tabIndex={-1}>child</div>}
      <div role="treeitem" aria-level={1} tabIndex={-1}>last</div>
    </TreeRows>
  }
  render(<Folder />)
  const folder = screen.getAllByRole('treeitem')[0]!
  folder.focus()
  fireEvent.keyDown(folder, { key: 'ArrowLeft' })
  fireEvent.keyDown(folder, { key: 'ArrowRight' })
  expect(toggle).toHaveBeenCalledTimes(1)
  expect(document.activeElement).toBe(folder)
  fireEvent.keyDown(folder, { key: 'ArrowRight' })
  expect(document.activeElement?.textContent).toBe('child')
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
  expect(document.activeElement).toBe(folder)
  fireEvent.keyDown(folder, { key: 'ArrowLeft' })
  expect(toggle).toHaveBeenCalledTimes(2)
  expect(screen.getAllByRole('treeitem')).toHaveLength(2)
  const last = screen.getAllByRole('treeitem')[1]!
  last.focus()
  fireEvent.keyDown(last, { key: 'ArrowRight' })
  fireEvent.keyDown(last, { key: 'ArrowLeft' })
  expect(document.activeElement).toBe(last)
})

it('leaves non-row controls and empty expanded folders at their current focus', () => {
  render(<TreeRows className="rows" label="Sessions">
    <button>Load more</button>
    <div role="treeitem" aria-level={1} aria-expanded="true" tabIndex={-1}>Empty folder</div>
    <div role="treeitem" aria-level={1} aria-expanded="true" tabIndex={-1}>Last folder</div>
  </TreeRows>)
  const button = screen.getByRole('button')
  button.focus()
  fireEvent.keyDown(button, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(button)
  for (const row of screen.getAllByRole('treeitem')) {
    row.focus()
    fireEvent.keyDown(row, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(row)
  }
})

it('keeps late slot actions out of the Tab order on inactive rows', async () => {
  function Actions() {
    const [visible, setVisible] = useState(false)
    return <><button onClick={() => { setVisible(true) }}>Show actions</button>
      {visible && <button>Late action</button>}</>
  }
  render(<TreeRows className="rows" label="Sessions">
    <div role="treeitem" tabIndex={-1}>First</div>
    <div role="treeitem" tabIndex={-1}>Second<Actions /></div>
  </TreeRows>)
  fireEvent.click(screen.getByRole('button', { name: 'Show actions' }))
  await new Promise<void>((resolve) => { queueMicrotask(resolve) })
  expect(screen.getByRole('button', { name: 'Late action' }).tabIndex).toBe(-1)
})
