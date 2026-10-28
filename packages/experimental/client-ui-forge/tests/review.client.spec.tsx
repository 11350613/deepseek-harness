// @vitest-environment jsdom
/** Frozen line references, durable pending reviews, and plain-text destination actions. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Profiler } from 'react'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ForgeDiffFile } from '../src/types.ts'
import { formatReviewComment, selectReviewLines, type ReviewSelection } from '../src/client/review.ts'
import { ReviewQueue } from '../src/client/review-queue.ts'
import { ReviewComposer } from '../src/client/ReviewComposer.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)
const file: ForgeDiffFile = { path: 'a.ts', previousPath: null, status: 'modified', binary: false, oversized: false, untracked: false, additions: 3, deletions: 2,
  hunks: [
    { oldStart: 2, oldLines: 2, newStart: 2, newLines: 3, lines: [' unchanged', '-old', '+new', '+another'] },
    { oldStart: 10, oldLines: 1, newStart: 11, newLines: 1, lines: ['-last', '+final'] },
  ] }

const selection: ReviewSelection = { source: { kind: 'change', url: 'https://github.com/octo/demo/pull/7', headSha: 'a'.repeat(40) },
  comment: { ...selectReviewLines(file, 'R', 3, 4)!, body: '为什么新增这两行？' } }
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

describe('review references', () => {
  it('keeps native draft edits through rerenders and updates React only when action availability changes', () => {
    const commits = vi.fn()
    const addToInput = vi.fn().mockReturnValue(true)
    const actions = { source: selection.source, addToInput }
    const empty = { ...selection, comment: { ...selection.comment, body: '' } }
    const close = vi.fn()
    const view = render(<Profiler id="comment" onRender={commits}>
      <ReviewComposer selection={empty} actions={actions} close={close} t={t} />
    </Profiler>)
    const input = view.getByRole('textbox')
    const send = view.getByRole('button', { name: 'Add to input' })
    expect(send).toHaveProperty('disabled', true)
    fireEvent.change(input, { target: { value: '先检查' } })
    expect(send).toHaveProperty('disabled', false)
    commits.mockClear()
    for (const value of ['先检查边界', '先检查边界\n再补测试', '先检查边界\n再补测试。']) fireEvent.change(input, { target: { value } })
    expect(commits).not.toHaveBeenCalled()
    view.rerender(<Profiler id="comment" onRender={commits}>
      <ReviewComposer selection={empty} actions={{ ...actions }} close={close} t={t} />
    </Profiler>)
    expect(input).toHaveProperty('value', '先检查边界\n再补测试。')
    fireEvent.change(input, { target: { value: ' \n' } })
    expect(send).toHaveProperty('disabled', true)
    fireEvent.change(input, { target: { value: '已修改的内容' } })
    fireEvent.click(send)
    expect(addToInput).toHaveBeenCalledWith({ ...selection, comment: { ...selection.comment, body: '已修改的内容' } })
  })
  it('keeps sides, reversed ranges, and the complete hunk while refusing gaps and cross-hunk selection', () => {
    expect(selectReviewLines(file, 'R', 4, 3)).toEqual({ ...selection.comment, body: '' })
    expect(selectReviewLines(file, 'L', 3, 3)?.hunk).toContain('-old\n+new')
    expect(selectReviewLines(file, 'L', 4, 4)).toBeUndefined()
    expect(selectReviewLines(file, 'R', 4, 11)).toBeUndefined()
    expect(formatReviewComment(selection, 1)).toBe(`## User Comment 1\nFile: a.ts\nSide: R\nLines: 3-4\nSource: https://github.com/octo/demo/pull/7\nCommit: ${'a'.repeat(40)}\nDiff hunk:\n\`\`\`diff\n@@ -2,2 +2,3 @@\n unchanged\n-old\n+new\n+another\n\`\`\`\nComment:\n为什么新增这两行？`)
    expect(formatReviewComment({ source: { kind: 'local', scope: 'staged' }, comment: { ...selection.comment, startLine: 4, hunk: '```' } }, 2))
      .toContain('Lines: 4\nSource: Local (staged)\nDiff hunk:\n````diff\n```\n````')
  })
  it('adds a quote without posting or closing when the input refuses it', () => {
    const addToInput = vi.fn().mockReturnValue(false)
    const close = vi.fn()
    const view = render(<ReviewComposer selection={selection} actions={{ source: selection.source, addToInput }} close={close} t={t} />)
    fireEvent.click(view.getByRole('button', { name: 'Add to input' }))
    expect(addToInput).toHaveBeenCalledWith(selection)
    expect(close).not.toHaveBeenCalled()
    expect(view.getByRole('alert').textContent).toContain('cannot accept')
    expect(view.queryByRole('button', { name: 'Publish single comment' })).toBeNull()
    addToInput.mockReturnValue(true)
    fireEvent.click(view.getByRole('button', { name: 'Add to input' }))
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('keeps the single-comment publish action inside the GitHub split menu', async () => {
    const publish = vi.fn().mockResolvedValue(undefined)
    const queue = vi.fn().mockReturnValue(true)
    const close = vi.fn()
    const view = render(<ReviewComposer selection={selection}
      actions={{ source: selection.source, addToInput: () => true, publish, queue }} close={close} t={t} />)
    expect(view.getByRole('button', { name: 'Start review' })).toBeTruthy()
    expect(view.queryByRole('button', { name: 'Publish single comment' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'GitHub comment options' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.queryByRole('menu')).toBeNull()
    expect(publish).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'GitHub comment options' }))
    fireEvent.click(within(view.getByRole('menu')).getByRole('menuitem', { name: 'Publish single comment' }))
    await vi.waitFor(() => { expect(close).toHaveBeenCalledOnce() })
    expect(publish).toHaveBeenCalledWith(selection)
    expect(queue).not.toHaveBeenCalled()
  })
  it('keeps the comment text when GitHub refuses publication', async () => {
    const close = vi.fn()
    const publish = vi.fn().mockResolvedValue('Permission denied')
    const view = render(<ReviewComposer selection={selection}
      actions={{ source: selection.source, addToInput: () => true, publish }} close={close} t={t} />)
    fireEvent.click(view.getByRole('button', { name: 'Publish single comment' }))
    expect(await view.findByRole('alert')).toHaveProperty('textContent', 'Permission denied')
    expect(view.getByRole('textbox')).toHaveProperty('value', selection.comment.body)
    expect(close).not.toHaveBeenCalled()
  })
})

describe('pending reviews', () => {
  it('clears every record on close and rejects a publication receipt arriving afterwards', () => {
    const queue = new ReviewQueue('review-test')
    queue.add(selection)
    queue.recordAgent(selection)
    queue.summarize('Summary', 'request-changes')
    queue.begin({ kind: 'comment', headSha: 'a'.repeat(40), comment: selection.comment })
    expect(queue.close()).toBe(true)
    expect(localStorage.getItem('review-test')).toBeNull()
    expect(queue.published(selection, 'https://github.com/octo/demo/pull/7#comment-1')).toBe(false)
    expect(queue.finish(true)).toBe(false)
    expect(queue.recordAgent(selection)).toBe(false)
    expect(new ReviewQueue('review-test').getSnapshot()).toMatchObject({ comments: [], records: [], body: '', uncertain: null })
  })
  it('closes in memory and reports a storage removal failure', () => {
    const queue = new ReviewQueue('review-test')
    queue.add(selection)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(() => { throw new DOMException('Denied', 'SecurityError') })
    expect(queue.close()).toBe(false)
    expect(queue.getSnapshot().comments).toEqual([])
    expect(queue.add(selection)).toBe(false)
  })
  it('restores frozen comments and summary, persisting uncertainty before dispatch', () => {
    const queue = new ReviewQueue('review-test')
    const listener = vi.fn()
    const release = queue.subscribe(listener)
    expect(queue.add(selection)).toBe(true)
    queue.summarize('Check the logic', 'request-changes')
    const write = { kind: 'review' as const, headSha: 'a'.repeat(40), event: 'request-changes' as const, body: 'Check the logic', comments: [{ path: selection.comment.path, side: selection.comment.side, startLine: selection.comment.startLine, endLine: selection.comment.endLine, body: selection.comment.body }] }
    expect(queue.begin(write)).toBe(true)
    expect(new ReviewQueue('review-test').getSnapshot()).toMatchObject({ comments: [selection], uncertain: write })
    expect(queue.begin(write)).toBe(false)
    expect(queue.add(selection)).toBe(false)
    expect(queue.edit(0, 'different')).toBe(false)
    queue.finish(false)
    queue.edit(0, 'updated')
    expect(queue.getSnapshot().comments[0]?.comment.body).toBe('updated')
    queue.finish(true)
    expect(new ReviewQueue('review-test').getSnapshot().comments).toEqual([])
    release()
    expect(listener).toHaveBeenCalled()
  })
  it('restores old drafts and keeps inline identities through editing and publication', () => {
    localStorage.setItem('review-test', JSON.stringify({ comments: [selection], body: '', event: 'comment', uncertain: null }))
    const queue = new ReviewQueue('review-test')
    const first = queue.fileComments('a.ts', selection.source)
    expect(first.threads).toHaveLength(1)
    expect(queue.fileComments('unrelated.ts', selection.source).threads).toHaveLength(0)
    queue.summarize('Summary', 'comment')
    expect(queue.fileComments('a.ts', selection.source)).toBe(first)
    const key = first.threads[0]!.key
    expect(queue.editThread(key, 'Updated')).toBe(true)
    const edited = queue.fileComments('a.ts', selection.source)
    expect(edited.threads[0]).toMatchObject({ key, kind: 'pending', selection: { comment: { body: 'Updated' } } })
    queue.finish(true, 'https://github.com/octo/demo/pull/7#review-1')
    expect(queue.fileComments('a.ts', selection.source).threads[0]).toMatchObject({ key, kind: 'published' })
    expect(new ReviewQueue('review-test').fileComments('a.ts', selection.source).threads[0]).toMatchObject({ kind: 'published' })
    const local = { ...selection, source: { kind: 'local' as const, scope: 'staged' } }
    expect(queue.recordAgent(local)).toBe(true)
    expect(queue.fileComments('a.ts', local.source).threads).toHaveLength(1)
    expect(queue.fileComments('a.ts', { kind: 'local', scope: 'branch' }).threads).toHaveLength(0)
  })
  it('preserves malformed stored bytes and refuses to overwrite them', () => {
    localStorage.setItem('review-test', 'broken')
    const queue = new ReviewQueue('review-test')
    expect(queue.getSnapshot().error).toBe('load')
    expect(queue.add(selection)).toBe(false)
    expect(localStorage.getItem('review-test')).toBe('broken')
  })
  it('keeps the previous queue on quota failure and allows retry after recovery', () => {
    const queue = new ReviewQueue('review-test')
    const setter = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new DOMException('quota', 'QuotaExceededError') })
    expect(queue.add(selection)).toBe(false)
    expect(queue.getSnapshot()).toMatchObject({ error: 'save', comments: [] })
    setter.mockRestore()
    expect(queue.add(selection)).toBe(true)
    expect(queue.getSnapshot().error).toBeNull()
  })
})
