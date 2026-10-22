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
