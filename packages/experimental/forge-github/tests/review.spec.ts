/** GitHub review mutations preserve explicit sides and commits and never retry ambiguous writes. */
import { describe, expect, it, vi } from 'vitest'
import type { ForgeReviewRequest } from '@deepseek-ai/dsh-experimental-forge'
import { GitHubProvider } from '../src/provider.ts'
import { GhTimeoutError, GhUnavailableError, type GhRunner } from '../src/gh.ts'

const ref = { repository: { forge: 'github', host: 'github.com', owner: 'octo', name: 'demo' }, number: 7 }
const head = 'a'.repeat(40)
const comment = { path: 'src/space name.ts', side: 'L' as const, startLine: 3, endLine: 5, body: 'Check `$(secret)`\n第二行' }
const single: ForgeReviewRequest = { kind: 'comment', headSha: head, comment }
const success = { exitCode: 0, stdout: JSON.stringify({ html_url: 'https://github.com/octo/demo/pull/7#discussion_r1' }), stderr: '' }
function fixture() {
  const gh = vi.fn<GhRunner>().mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ head: { sha: head }, state: 'open' }), stderr: '' }).mockResolvedValue(success)
  return { gh, provider: new GitHubProvider(gh, ['github.com']), signal: new AbortController().signal }
}

describe('review submission', () => {
  it('posts one multiline left-side comment as JSON stdin at the reviewed commit', async () => {
    const { gh, provider, signal } = fixture()
    expect(await provider.submitReview(ref, single, signal)).toMatchObject({ ok: true })
    expect(gh.mock.calls[1]).toEqual([
      ['api', '--hostname', 'github.com', '--method', 'POST', 'repos/octo/demo/pulls/7/comments', '--input', '-'], signal,
      JSON.stringify({ commit_id: head, path: comment.path, side: 'LEFT', line: 5, body: comment.body, start_line: 3, start_side: 'LEFT' }),
    ])
  })
  it.each(['comment', 'approve', 'request-changes'] as const)('sends one %s review containing all pending comments', async (event) => {
    const { gh, provider, signal } = fixture()
    await provider.submitReview(ref, { kind: 'review', headSha: head, event, body: 'Summary', comments: [comment, { ...comment, side: 'R', startLine: 5 }] }, signal)
    expect(gh).toHaveBeenCalledTimes(2)
    expect(JSON.parse(gh.mock.calls[1]?.[2] ?? '')).toEqual({ commit_id: head, event: { comment: 'COMMENT', approve: 'APPROVE', 'request-changes': 'REQUEST_CHANGES' }[event], body: 'Summary', comments: [
      { path: comment.path, side: 'LEFT', line: 5, body: comment.body, start_line: 3, start_side: 'LEFT' },
      { path: comment.path, side: 'RIGHT', line: 5, body: comment.body },
    ] })
  })
  it('refuses changed heads before dispatching a write', async () => {
    const { gh, provider, signal } = fixture()
    expect(await provider.submitReview(ref, { ...single, headSha: 'b'.repeat(40) }, signal)).toMatchObject({ ok: false, code: 'stale' })
    expect(gh).toHaveBeenCalledTimes(1)
  })
  it.each([
    ['gh: Validation failed (HTTP 422)', 'failed'], ['gh: Bad credentials (HTTP 401)', 'failed'], ['gh: Server error (HTTP 503)', 'unknown'],
  ])('classifies %s without retrying', async (stderr, code) => {
    const { gh, provider, signal } = fixture()
    gh.mockResolvedValue({ exitCode: 1, stdout: '', stderr })
    expect(await provider.submitReview(ref, single, signal)).toMatchObject({ ok: false, code })
    expect(gh).toHaveBeenCalledTimes(2)
  })
  it.each([[new GhTimeoutError('timed out'), 'unknown'], [new GhUnavailableError('missing'), 'failed']])('retains uncertainty when the write cannot finish: %s', async (error, code) => {
    const { gh, provider, signal } = fixture()
    gh.mockRejectedValue(error)
    expect(await provider.submitReview(ref, single, signal)).toMatchObject({ ok: false, code })
    expect(gh).toHaveBeenCalledTimes(2)
  })
  it('rejects an unexpected receipt instead of claiming publication', async () => {
    const { gh, provider, signal } = fixture()
    gh.mockResolvedValue({ ...success, stdout: '{}' })
    expect(await provider.submitReview(ref, single, signal)).toMatchObject({ ok: false, code: 'unknown' })
  })
})
