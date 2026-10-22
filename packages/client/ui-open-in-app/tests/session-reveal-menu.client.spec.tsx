// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionRevealMenuItem } from '../src/client/SessionRevealMenuItem.tsx'
import { en } from '../src/client/locales.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'

afterEach(cleanup)

it.each([
  [['finder'], '/workspace', 'Show in Finder', false],
  [['explorer'], '/workspace', 'Show in folder', false],
  [['vscode'], '/workspace', 'Show in folder', true],
  [null, '/workspace', 'Show in folder', true],
  [['finder'], undefined, 'Show in Finder', true],
] as const)('reveals the captured directory with catalog %j and path %s', (apps, cwd, label, disabled) => {
  const sessionId = SessionId('captured')
  const state: SessionListState = { ids: [sessionId], byId: {
    [sessionId]: { id: sessionId, ...(cwd === undefined ? {} : { cwd }), displayTitle: 'Captured', running: false, blank: false, updatedAt: 1, retainedBy: {} },
  }, phase: 'ready', projectionsBySession: {} }
  const dismiss = vi.fn(), reveal = vi.fn(async () => {})
  const props: ComponentProps<typeof SessionRevealMenuItem> = {
    sessionId, useSessions: select => select(state), useDirectoryApps: select => select(apps),
    useMenuOpenState: () => [true, dismiss], reveal, t: makeTranslate(en, commonEn),
  }
  const view = render(<SessionRevealMenuItem {...props} />)
  const item = view.getByRole('menuitem', { name: label })
  expect(item.hasAttribute('disabled')).toBe(disabled)
  fireEvent.click(item)
  if (disabled) {
    expect(reveal).not.toHaveBeenCalled()
    expect(dismiss).not.toHaveBeenCalled()
  } else {
    expect(dismiss).toHaveBeenCalledWith(false)
    expect(reveal).toHaveBeenCalledWith(apps?.[0], cwd)
    expect(dismiss.mock.invocationCallOrder[0]).toBeLessThan(reveal.mock.invocationCallOrder[0]!)
  }
})
