// @vitest-environment jsdom
/** Changed-file directories, searching, and keyboard disclosure without reading repository contents. */
import { useState } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ForgeDiffFile } from '../src/types.ts'
import { ChangedFiles, type ChangedFilesState } from '../src/client/ChangedFiles.tsx'
import { changedFileTree, filterFileTree } from '../src/client/file-tree.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function file(path: string, previousPath: string | null = null): ForgeDiffFile {
  return { path, previousPath, status: previousPath === null ? 'modified' : 'renamed', binary: false, oversized: false, untracked: false, additions: 1, deletions: 0, hunks: [] }
}

it('compacts directory chains, sorts directories before files, and keeps identical basenames distinct', () => {
  const tree = changedFileTree([file('z.ts'), file('src/client/b.ts'), file('docs/a.ts'), file('src/client/a.ts')])
  expect(tree.map(node => [node.kind, node.name])).toEqual([['directory', 'docs'], ['directory', 'src/client'], ['file', 'z.ts']])
  expect(filterFileTree(tree, 'A.TS').map(node => node.path)).toEqual(['docs', 'src/client'])
  expect(filterFileTree(tree, ' ')).toBe(tree)
  expect(filterFileTree(tree, 'missing')).toEqual([])
  expect(changedFileTree([])).toEqual([])
})

it('matches renamed paths and keeps file names containing backslashes literal', () => {
  const tree = changedFileTree([file('lib/new.ts', 'src/old.ts'), file('a\\b.ts')])
  expect(filterFileTree(tree, 'old.ts').map(node => node.path)).toEqual(['lib'])
  expect(tree[1]).toMatchObject({ kind: 'file', path: 'a\\b.ts' })
})

it('searches through folded directories and restores their fold state when search is cleared', () => {
  const jump = vi.fn()
  const files = [file('src/a.ts'), file('src/b.ts'), file('README.md')]
  function Harness() {
    const [state, setState] = useState<ChangedFilesState>({ query: '', collapsed: {}, selected: null })
    return <ChangedFiles files={files} state={state} t={makeTranslate(en)} jump={jump}
      filter={(query) => { setState(value => ({ ...value, query })) }}
      toggle={(path) => { setState(value => ({ ...value, collapsed: { ...value.collapsed, [path]: !value.collapsed[path] } })) }} />
  }
  const view = render(<Harness />)
  fireEvent.keyDown(view.getByRole('button', { name: 'src' }), { key: 'ArrowLeft' })
  expect(view.queryByRole('button', { name: 'src/a.ts' })).toBeNull()
  fireEvent.change(view.getByRole('textbox'), { target: { value: 'a.ts' } })
  fireEvent.click(view.getByRole('button', { name: 'src/a.ts' }))
  expect(jump).toHaveBeenCalledWith('src/a.ts')
  expect(view.queryByRole('button', { name: 'README.md' })).toBeNull()
  fireEvent.change(view.getByRole('textbox'), { target: { value: '' } })
  expect(view.queryByRole('button', { name: 'src/a.ts' })).toBeNull()
  fireEvent.keyDown(view.getByRole('button', { name: 'src' }), { key: 'ArrowRight' })
  expect(view.getByRole('button', { name: 'src/a.ts' })).toBeTruthy()
  fireEvent.change(view.getByRole('textbox'), { target: { value: 'missing' } })
  expect(view.getByText('No matching files')).toBeTruthy()
})
