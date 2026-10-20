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
  const activateRow = useRef<((row: HTMLElement) => void) | null>(null)
  const originalTabs = useRef(new WeakMap<HTMLElement, string | null>()).current
  const rows = (tree: HTMLDivElement): HTMLElement[] => Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]'))
  useLayoutEffect(() => {
    const tree = root.current
    /* v8 ignore next -- the tree element is attached before its layout effect. */
    if (tree === null) return
    let active: HTMLElement | undefined
    let known = new Set<HTMLElement>()
    const actions = (row: HTMLElement) => row.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')
    const syncRow = (row: HTMLElement): void => {
      const enabled = row === active
      row.tabIndex = enabled ? 0 : -1
      for (const action of actions(row)) {
        if (enabled) {
          if (!originalTabs.has(action)) continue
          const original = originalTabs.get(action)
          if (original == null) action.removeAttribute('tabindex')
          else action.setAttribute('tabindex', original)
          originalTabs.delete(action)
        } else {
          if (!originalTabs.has(action)) originalTabs.set(action, action.getAttribute('tabindex'))
          action.tabIndex = -1
        }
      }
    }
    const select = (row: HTMLElement): void => {
      if (row === active) return
      const previous = active
      active = row
      if (previous !== undefined) syncRow(previous)
      syncRow(row)
    }
    const syncMembers = (): void => {
      const items = rows(tree)
      const next = new Set(items)
      for (const row of next) if (!known.has(row)) syncRow(row)
      known = next
      if (active === undefined || !known.has(active)) {
        const target = items.find(row => row.contains(tree.ownerDocument.activeElement))
          ?? items.find(row => row.getAttribute('aria-selected') === 'true') ?? items[0]
        if (target !== undefined) select(target)
        else active = undefined
      }
    }
    const observe = (): void => { observer.observe(tree, { childList: true, subtree: true, attributes: true, attributeFilter: ['tabindex'] }) }
    const syncMutations = (records: MutationRecord[]): void => {
      const changed = new Set<HTMLElement>()
      let membershipChanged = false
      for (const record of records) {
        const target = record.target instanceof HTMLElement ? record.target : record.target.parentElement
        const row = target?.closest<HTMLElement>('[role="treeitem"]')
        if (row != null) changed.add(row)
        if (record.type === 'attributes' && target != null && target !== row && originalTabs.has(target)) {
          originalTabs.set(target, target.getAttribute('tabindex'))
        }
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          if (node instanceof Element && (node.matches('[role="treeitem"]') || node.querySelector('[role="treeitem"]') !== null)) {
            membershipChanged = true
          }
        }
      }
      if (membershipChanged) syncMembers()
      for (const row of changed) if (known.has(row)) syncRow(row)
    }
    // Only DOM membership or owned tabindex changes require work; Session text updates touch their own row.
    const observer = new MutationObserver((records) => {
      observer.disconnect()
      syncMutations(records)
      observe()
    })
    syncMembers()
    observe()
    activateRow.current = (row) => {
      const pending = observer.takeRecords()
      observer.disconnect()
      syncMutations(pending)
      select(row)
      observe()
    }
    return () => { observer.disconnect() }
  }, [root, originalTabs])
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
      if (row !== null && event.currentTarget.contains(row)) activateRow.current?.(row)
    }}>
    {children}
  </div>
}
