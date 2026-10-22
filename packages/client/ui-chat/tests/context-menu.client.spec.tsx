// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { chatContextKey, openChatContextMenu } from '../src/client/chat/context-menu.ts'

afterEach(cleanup)

it('copies the recorded path target rather than a tool or reference display label, and preserves URL query and fragment', () => {
  const open = vi.fn()
  const view = render(<div onContextMenu={(event) => { openChatContextMenu(event, open) }}>
    <button data-file-path="/workspace/output.txt" data-file-line="42">output.txt:42</button>
    <a href="https://example.com/path?q=1#fragment">Website</a>
  </div>)
  fireEvent.contextMenu(view.getByRole('button'), { clientX: 50, clientY: 70 })
  expect(open).toHaveBeenLastCalledWith({ kind: 'file', path: '/workspace/output.txt', line: 42 }, { x: 50, y: 70 })
  fireEvent.contextMenu(view.getByRole('link'), { clientX: 80, clientY: 90 })
  expect(open).toHaveBeenLastCalledWith({ kind: 'url', url: 'https://example.com/path?q=1#fragment' }, { x: 80, y: 90 })
})

it('opens keyboard menus from their focused reference and leaves images, editors, and unrelated gestures alone', () => {
  const open = vi.fn()
  const view = render(<div onKeyDown={(event) => { chatContextKey(event, open) }}
    onContextMenu={(event) => { openChatContextMenu(event, open) }}>
    <button data-file-path="/workspace/folder">Folder</button>
    <a href="https://example.com"><img alt="Image" /></a>
    <textarea defaultValue="Editor" />
  </div>)
  const source = view.getByRole('button')
  source.getBoundingClientRect = () => new DOMRect(30, 40, 100, 20)
  fireEvent.keyDown(source, { key: 'F10', shiftKey: true })
  expect(open).toHaveBeenLastCalledWith({ kind: 'file', path: '/workspace/folder' }, { x: 30, y: 60 })
  expect(document.activeElement).toBe(source)
  fireEvent.keyDown(source, { key: 'ContextMenu' })
  expect(open).toHaveBeenCalledTimes(2)
  fireEvent.keyDown(source, { key: 'F10' })
  fireEvent.keyDown(source, { key: 'F10', shiftKey: true, repeat: true })
  fireEvent.keyDown(source, { key: 'F10', shiftKey: true, isComposing: true })
  fireEvent.contextMenu(view.getByRole('img'))
  fireEvent.contextMenu(view.getByRole('textbox'))
  expect(open).toHaveBeenCalledTimes(2)
})
