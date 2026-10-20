/** Keyboard focus and navigation shared by the sidebar's rendered row lists. */
import { useLayoutEffect, useRef } from 'react'
import type { KeyboardEvent, ReactNode, RefObject } from 'react'

/**
 * Keep one row and its actions in the Tab order; arrow keys walk visible rows.
 * @param props - rendered rows, accessible label, and optional animation ref/input callback.
 * @returns the tree container; child rows provide their nesting through aria-level.
 */
export function TreeRows({ children, className, label, listRef, onInput }: {
  children: ReactNode
  className?: string | undefined
  label: string
  listRef?: RefObject<HTMLDivElement>
  onInput?: () => void
}) {
  const ownRef = useRef<HTMLDivElement>(null)
  const root = listRef ?? ownRef
  const active = useRef<HTMLElement | null>(null)
  const originalTabs = useRef(new WeakMap<HTMLElement, string | null>())
  const rows = (tree: HTMLDivElement): HTMLElement[] => Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]'))
  const activate = (row: HTMLElement, tree: HTMLDivElement): void => {
    active.current = row
    for (const item of rows(tree)) {
      item.tabIndex = item === row ? 0 : -1
      for (const action of item.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')) {
        if (!originalTabs.current.has(action)) originalTabs.current.set(action, action.getAttribute('tabindex'))
        const original = originalTabs.current.get(action)
        if (item !== row) action.tabIndex = -1
        else if (original == null) action.removeAttribute('tabindex')
        else action.setAttribute('tabindex', original)
      }
    }
  }
  useLayoutEffect(() => {
    const tree = root.current as HTMLDivElement
    const update = (): void => {
      const items = rows(tree)
      const target = items.find(row => row === active.current)
        ?? items.find(row => row.getAttribute('aria-selected') === 'true') ?? items[0]
      if (target !== undefined) activate(target, tree)
    }
    update()
    // Slot-owned actions can mount without rerendering their tree container.
    const observer = new MutationObserver(update)
    observer.observe(tree, { childList: true, subtree: true })
    return () => { observer.disconnect() }
  })
  const navigate = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const items = rows(event.currentTarget)
    const index = items.findIndex(row => row === event.target)
    const row = items[index]
    if (row === undefined) return
    let target: HTMLElement | undefined
    const next = items[index + 1]
    const level = (item: HTMLElement): number => Number(item.getAttribute('aria-level') ?? 1)
    switch (event.key) {
      case 'ArrowDown': target = items[Math.min(index + 1, items.length - 1)]; break
      case 'ArrowUp': target = items[Math.max(index - 1, 0)]; break
      case 'Home': target = items[0]; break
      case 'End': target = items.at(-1); break
      case 'ArrowRight':
        if (row.getAttribute('aria-expanded') === 'false') row.click()
        else if (row.getAttribute('aria-expanded') === 'true' && next !== undefined
          && level(next) > level(row)) target = next
        break
      case 'ArrowLeft':
        if (row.getAttribute('aria-expanded') === 'true') row.click()
        else target = items.slice(0, index).findLast(item => level(item) < level(row))
        break
      default: return
    }
    event.preventDefault()
    target?.focus()
  }
  return <div ref={root} className={className} role="tree" aria-label={label}
    onPointerDownCapture={onInput} onKeyDownCapture={onInput} onKeyDown={navigate}
    onFocusCapture={(event) => {
      const row = event.target.closest<HTMLElement>('[role="treeitem"]')
      if (row !== null && event.currentTarget.contains(row)) activate(row, event.currentTarget)
    }}>
    {children}
  </div>
}
