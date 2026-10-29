/** Request header contributions reach the provider without crossing call lifetimes. */

import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { userAgent } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as PiAi from '../src/index.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(async () => {
  await closeMockServers()
  vi.unstubAllEnvs()
})

async function harness(baseURL: string, otherURL?: string): Promise<Context> {
  vi.stubEnv('PI_HEADERS_KEY', 'fixture-key')
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(PiAi, { providers: { deepseek: {
    apiKeyEnv: 'PI_HEADERS_KEY', baseURL,
    headers: { 'X-Company': 'static', 'X-Request-Session': 'static-session' },
  }, ...otherURL === undefined ? {} : { gateway: {
    apiKeyEnv: 'PI_HEADERS_KEY', api: 'openai-completions', baseURL: otherURL, models: [{ id: 'm' }],
  } } } })
  return ctx
}

it('composes request-local headers, enforces attribution, and removes disposed listeners', async () => {
  const server = await mockServer(Array.from({ length: 3 }, () => ({ events: textEvents })))
  const ctx = await harness(server.url)
  const seen: PiAi.PiAiRequestHeaderContext[] = []
  const remove = ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
    seen.push(request)
    expect(Object.isFrozen(request)).toBe(true)
    if (request.sessionId === undefined) headers.delete('x-request-session')
    else headers.set('x-request-session', request.sessionId)
    headers.set('USER-AGENT', 'contributor')
    return next()
  })
  const removeSecond = ctx.on('llm-pi-ai/request-headers', (_request, headers, next) => {
    headers.set('x-second-listener', 'yes')
    return next()
  })
  await assemble(ctx, { model: 'deepseek-flash', messages: [], sessionId: SessionId('one') })
  await assemble(ctx, { model: 'deepseek-flash', messages: [] })
  expect(seen).toEqual([
    { provider: 'deepseek', model: 'deepseek-flash', baseURL: server.url, sessionId: 'one' },
    { provider: 'deepseek', model: 'deepseek-flash', baseURL: server.url },
  ])
  expect(server.headers[0]).toMatchObject({
    'x-request-session': 'one', 'x-company': 'static', 'x-second-listener': 'yes', 'user-agent': userAgent(),
  })
  expect(server.headers[1]).not.toHaveProperty('x-request-session')
  remove()
  removeSecond()
  await assemble(ctx, { model: 'deepseek-flash', messages: [], sessionId: SessionId('two') })
  expect(server.headers[2]).toMatchObject({ 'x-request-session': 'static-session', 'x-company': 'static' })
  expect(server.headers[2]).not.toHaveProperty('x-second-listener')
})

it('uses the prepared endpoint and isolates overlapping requests', async () => {
  const first = await mockServer([{ events: textEvents, holdOpen: true }])
  const second = await mockServer([{ events: textEvents }])
  const ctx = await harness(first.url, second.url)
  const seen: PiAi.PiAiRequestHeaderContext[] = []
  ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
    seen.push(request)
    headers.set('x-request-session', String(request.sessionId))
    return next()
  })
  const prepared = await ctx.llm.prepareCall({ provider: 'deepseek', model: 'deepseek-flash' })
  const iterator = prepared.stream({ ...prepared.config, messages: [], sessionId: SessionId('first') })[Symbol.asyncIterator]()
  onTestFinished(async () => { await iterator.return?.() })
  await iterator.next()
  await assemble(ctx, { provider: 'gateway', model: 'm', messages: [], sessionId: SessionId('second') })
  while (!(await iterator.next()).done) { /* Drain the first response after the second call settles. */ }
  expect(seen.map(({ provider, baseURL, sessionId }) => ({ provider, baseURL, sessionId }))).toEqual([
    { provider: 'deepseek', baseURL: first.url, sessionId: 'first' },
    { provider: 'gateway', baseURL: second.url, sessionId: 'second' },
  ])
  expect(first.headers[0]?.['x-request-session']).toBe('first')
  expect(second.headers[0]?.['x-request-session']).toBe('second')
})

it.each(['throw', 'invalid header'] as const)('fails before HTTP dispatch when a contributor reports %s', async (failure) => {
  const server = await mockServer([])
  const ctx = await harness(server.url)
  ctx.on('llm-pi-ai/request-headers', (_request, headers, next) => {
    if (failure === 'throw') throw new Error('fixture header failure')
    headers.set('invalid\nname', 'value')
    return next()
  })
  const result = await assemble(ctx, { model: 'deepseek-flash', messages: [] })
  expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'REQUEST_HEADERS' } })
  expect(server.requests).toHaveLength(0)
})
