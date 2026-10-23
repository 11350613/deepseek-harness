// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { contextMenuTrigger, MarkdownDelegateProvider, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

it('leaves undeclared plugin links alone and binds only explicitly rendered Markdown targets', () => {
  const open = vi.fn()
  const custom = vi.fn()
  const view = render(<MarkdownDelegateProvider openContextMenu={open} openFile={() => {}}>
    <a href="https://example.com/plugin">Plugin link</a>
    <MarkdownText text="[File](docs/file.ts#L42)" labels={{ code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' }} />
    <button {...contextMenuTrigger((point) => { custom({ kind: 'pluginDocument', id: 'one' }, point) })}>Plugin target</button>
  </MarkdownDelegateProvider>)
  expect(fireEvent.contextMenu(view.getByRole('link', { name: 'Plugin link' }))).toBe(true)
  expect(open).not.toHaveBeenCalled()
  const file = view.getByRole('button', { name: 'File' })
  fireEvent.contextMenu(file, { clientX: 40, clientY: 50 })
  expect(open).toHaveBeenLastCalledWith({ kind: 'file', path: 'docs/file.ts', line: 42 }, { x: 40, y: 50 })
  file.getBoundingClientRect = () => new DOMRect(30, 40, 100, 20)
  fireEvent.keyDown(file, { key: 'F10', shiftKey: true })
  expect(open).toHaveBeenLastCalledWith({ kind: 'file', path: 'docs/file.ts', line: 42 }, { x: 30, y: 60 })
  expect(document.activeElement).toBe(file)
  fireEvent.contextMenu(view.getByRole('button', { name: 'Plugin target' }), { clientX: 70, clientY: 80 })
  expect(custom).toHaveBeenCalledExactlyOnceWith({ kind: 'pluginDocument', id: 'one' }, { x: 70, y: 80 })
  expect(open).toHaveBeenCalledTimes(2)
})

it('keeps nested, cancelled and portaled gestures with their explicit owner', () => {
  const outer = vi.fn(), inner = vi.fn()
  const view = render(<div {...contextMenuTrigger(outer)}>
    <button {...contextMenuTrigger(inner)}>Inner</button>
    <button onContextMenu={(event) => { event.preventDefault() }}>Native</button>
    {createPortal(<button {...contextMenuTrigger(inner)}>Portal</button>, document.body)}
  </div>)
  fireEvent.contextMenu(view.getByText('Inner'))
  fireEvent.contextMenu(view.getByText('Native'))
  fireEvent.keyDown(view.getByText('Portal'), { key: 'ContextMenu' })
  expect(inner).toHaveBeenCalledTimes(2)
  expect(outer).not.toHaveBeenCalled()
  for (const options of [{}, { repeat: true, shiftKey: true }, { isComposing: true, shiftKey: true },
    { ctrlKey: true, shiftKey: true }, { altKey: true, shiftKey: true }, { metaKey: true, shiftKey: true }]) {
    fireEvent.keyDown(view.getByText('Inner'), { key: 'F10', ...options })
  }
  expect(inner).toHaveBeenCalledTimes(2)
})
