/** Pointer and keyboard placement shared by object-menu triggers. */

/**
 * Place keyboard-originated context events at the trigger, and pointer events at the cursor.
 * @param event - context event and its trigger element.
 * @returns viewport coordinates in CSS pixels.
 */
export function menuPoint(event: { clientX: number; clientY: number; currentTarget: Element }): { x: number; y: number } {
  if (event.clientX !== 0 || event.clientY !== 0) return { x: event.clientX, y: event.clientY }
  const rect = event.currentTarget.getBoundingClientRect()
  return { x: rect.left, y: rect.bottom }
}

/**
 * Bind a declared object to pointer and keyboard context gestures. Nested handlers
 * that prevent the event keep ownership; absent callbacks leave native behavior.
 * @param open - owner callback capturing the object, or undefined to opt out.
 * @returns handlers for the actual trigger element, including portaled elements.
 */
export function contextMenuTrigger(open: ((point: { x: number; y: number }) => void) | undefined):
Pick<import('react').HTMLAttributes<HTMLElement>, 'onContextMenu' | 'onKeyDown'> {
  if (open === undefined) return {}
  const show = (event: import('react').SyntheticEvent<HTMLElement>, point: { x: number; y: number }): void => {
    if (event.defaultPrevented) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.focus({ preventScroll: true })
    open(point)
  }
  return {
    onContextMenu: (event) => { show(event, menuPoint(event)) },
    onKeyDown: (event) => {
      if (event.repeat || event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey) return
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
      show(event, menuPoint({ clientX: 0, clientY: 0, currentTarget: event.currentTarget }))
    },
  }
}
