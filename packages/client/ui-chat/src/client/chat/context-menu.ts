/** Delegate reference and tool-file gestures to the shared context-menu capability. */
import type { KeyboardEvent, MouseEvent, SyntheticEvent } from 'react'
import type { ChatViewInjected } from '../contract/slots.ts'

function show(event: SyntheticEvent<HTMLElement>, open: ChatViewInjected['openContextMenu'], point?: { x: number; y: number }): void {
  if (event.defaultPrevented || !(event.target instanceof Element)) return
  if (event.target.closest('img, input, textarea, [contenteditable="true"], [role="menu"]')) return
  const source = event.target.closest<HTMLElement>('[data-file-path], a[href]')
  if (source === null || !event.currentTarget.contains(source)) return
  const path = source.getAttribute('data-file-path')
  const url = source.getAttribute('href')
  if (!path && (!url || !/^https?:\/\//iu.test(url))) return
  event.preventDefault(); event.stopPropagation()
  const rect = source.getBoundingClientRect()
  const position = point ?? { x: rect.left, y: rect.bottom }
  source.focus({ preventScroll: true })
  if (path) open({ kind: 'file', path }, position)
  else if (url) open({ kind: 'url', url }, position)
}

/**
 * Open the menu of a rendered file reference or URL.
 * @param event - bubbled pointer gesture.
 * @param open - captured Session menu callback.
 */
export function openChatContextMenu(event: MouseEvent<HTMLElement>, open: ChatViewInjected['openContextMenu']): void {
  show(event, open, event.clientX === 0 && event.clientY === 0 ? undefined : { x: event.clientX, y: event.clientY })
}

/**
 * Open a focused reference with the context key or Shift+F10.
 * @param event - keyboard menu request.
 * @param open - captured Session menu callback.
 */
export function chatContextKey(event: KeyboardEvent<HTMLElement>, open: ChatViewInjected['openContextMenu']): void {
  if (event.repeat || event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey) return
  if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) show(event, open)
}
