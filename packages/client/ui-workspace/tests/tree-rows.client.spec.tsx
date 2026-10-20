// @vitest-environment jsdom
/** Focus traversal through visible rows and their own action controls. */
import { StrictMode, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

it('retains the entry across reorder and chooses a surviving row after removal', async () => {
  const view = render(list(['one', 'two']))
  screen.getAllByRole('treeitem')[1]!.focus()
  view.rerender(list(['two', 'one', 'three']))
  expect(screen.getAllByRole('treeitem').map(row => row.tabIndex)).toEqual([0, -1, -1])
  view.rerender(list(['one', 'three']))
  await waitFor(() => { expect(screen.getAllByRole('treeitem').map(row => row.tabIndex)).toEqual([0, -1]) })
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

it('restores the latest action tabindex after a React update on an inactive row', async () => {
  function List({ tabIndex }: { tabIndex: number }) {
    return <TreeRows label="Sessions">
      <div role="treeitem" tabIndex={-1}>First</div>
      <div role="treeitem" tabIndex={-1}>Second<button tabIndex={tabIndex}>Action</button></div>
    </TreeRows>
  }
  const view = render(<List tabIndex={0} />)
  view.rerender(<List tabIndex={-1} />)
  await act(async () => {})
  screen.getAllByRole('treeitem')[1]!.focus()
  expect(screen.getByRole('button').tabIndex).toBe(-1)
  view.rerender(<List tabIndex={0} />)
  await waitFor(() => { expect(screen.getByRole('button').tabIndex).toBe(0) })
})

it('updates one running row without traversing the remaining 199 rows', async () => {
  function List({ running }: { running: boolean }) {
    return <TreeRows label="Sessions">{Array.from({ length: 200 }, (_, i) =>
      <div key={i} role="treeitem" tabIndex={-1}>{i === 100 && running ? <span>Running</span> : null}<button>Action {i}</button></div>,
    )}</TreeRows>
  }
  const view = render(<List running={false} />)
  const scans = screen.getAllByRole('treeitem').map(row => vi.spyOn(row, 'querySelectorAll'))
  view.rerender(<List running />)
  await act(async () => {})
  expect(screen.getByText('Running')).toBeTruthy()
  expect(scans.filter(scan => scan.mock.calls.length > 0)).toHaveLength(1)
  scans.forEach((scan) => { scan.mockRestore() })
})

it('accepts focus during mounting and updates SVG and text children without changing the entry', async () => {
  render(<TreeRows label="Sessions">
    <div role="treeitem" tabIndex={-1} aria-selected>First</div>
    <div role="treeitem" tabIndex={-1}><button autoFocus>Action</button><svg data-testid="status" /></div>
  </TreeRows>)
  const [first, row] = screen.getAllByRole('treeitem') as [HTMLElement, HTMLElement]
  await act(async () => {
    screen.getByTestId('status').append(document.createElementNS('http://www.w3.org/2000/svg', 'path'))
    row.append(document.createTextNode('Running'))
  })
  expect(first.tabIndex).toBe(-1)
  expect(row.tabIndex).toBe(0)
  expect(screen.getByRole('button').tabIndex).toBe(0)
  expect(document.activeElement).toBe(screen.getByRole('button'))
})

it('ignores action updates from a row removed in the same commit', async () => {
  const view = render(list(['one', 'two']))
  const removed = screen.getAllByRole('treeitem')[1]!
  act(() => {
    removed.append(document.createElement('button'))
    view.rerender(list(['one']))
  })
  await act(async () => {})
  expect(removed.isConnected).toBe(false)
  expect(screen.getByRole('treeitem').tabIndex).toBe(0)
  expect(screen.getByRole('button', { name: 'one actions' }).tabIndex).toBe(0)
})

it('keeps inactive actions reachable after StrictMode replays the layout effect', () => {
  render(<StrictMode>{list(['one', 'two'])}</StrictMode>)
  screen.getAllByRole('treeitem')[1]!.focus()
  expect(screen.getByRole('button', { name: 'two actions' }).tabIndex).toBe(0)
  expect(screen.getByRole('button', { name: 'one actions' }).tabIndex).toBe(-1)
})
