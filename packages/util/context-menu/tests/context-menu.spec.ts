// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createElement as h, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { contextMenuTrigger, menuPoint } from '../src/index.ts'

afterEach(cleanup)

it('places pointer gestures at the cursor and keyboard gestures at the focused trigger', () => {
  const open = vi.fn()
  const click = vi.fn()
  const view = render(h('button', { ...contextMenuTrigger(open), onClick: click }, 'Target'))
  const button = view.getByRole('button')
  button.getBoundingClientRect = () => new DOMRect(30, 40, 100, 20)
  for (const point of [{ x: 50, y: 60 }, { x: 0, y: 60 }, { x: 50, y: 0 }]) {
    expect(fireEvent.contextMenu(button, { clientX: point.x, clientY: point.y })).toBe(false)
    expect(open).toHaveBeenLastCalledWith(point)
  }
  for (const gesture of [{ key: 'F10', shiftKey: true }, { key: 'ContextMenu' }]) {
    expect(fireEvent.keyDown(button, gesture)).toBe(false)
    expect(open).toHaveBeenLastCalledWith({ x: 30, y: 60 })
    expect(document.activeElement).toBe(button)
  }
  expect(menuPoint({ clientX: 0, clientY: 0, currentTarget: button })).toEqual({ x: 30, y: 60 })
  expect(click).not.toHaveBeenCalled()
})

it('leaves native gestures unchanged when no menu callback is supplied', () => {
  const view = render(h('button', contextMenuTrigger(undefined), 'Native'))
  const button = view.getByRole('button')
  expect(fireEvent.contextMenu(button)).toBe(true)
  expect(fireEvent.keyDown(button, { key: 'F10', shiftKey: true })).toBe(true)
  expect(document.activeElement).not.toBe(button)
})

it('keeps nested, cancelled and portaled gestures with their explicit owner', () => {
  const outer = vi.fn(), inner = vi.fn()
  const view = render(h('div', contextMenuTrigger(outer),
    h('button', contextMenuTrigger(inner), 'Inner'),
    h('button', { onContextMenu: (event: MouseEvent) => { event.preventDefault() } }, 'Native'),
    createPortal(h('button', contextMenuTrigger(inner), 'Portal'), document.body),
  ))
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
