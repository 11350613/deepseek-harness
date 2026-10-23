/** Unified input receipt and observation over an independently running protocol peer. */
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createProcessDeepSeekHarness } from '../src/api.ts'
import { JsonRpcResponseError, RequestTimeoutError, SdkProtocolError, TransportClosedError } from '../src/index.ts'
import type { QueryMessage, RunResult } from '../src/types.ts'

function harnessWith(environment: Record<string, string> = {}, requestTimeoutMs?: number) {
  const harness = createProcessDeepSeekHarness({
    command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/query.ts', import.meta.url))],
    environment: () => ({ ...process.env, ...environment }),
    description: 'query protocol fixture',
    initializeTimeoutMs: 5000,
    ...requestTimeoutMs === undefined ? {} : { requestTimeoutMs },
  })
  onTestFinished(() => harness.close())
  return harness
}

async function collect(iterator: AsyncIterableIterator<QueryMessage>): Promise<QueryMessage[]> {
  const messages: QueryMessage[] = []
  for await (const message of iterator) messages.push(message)
  return messages
}

function finalRun(messages: QueryMessage[]): RunResult {
  const result = messages.at(-1)
  if (result === undefined || !('finalResponse' in result)) throw new Error('query did not yield RunResult')
  return result
}

it('sends a command without waiting for its result and buffers the complete command notifications', async () => {
  const harness = harnessWith({ QUERY_HOLD_COMMAND: '1' })
  const session = harness.session('main')
  await session.query('/compact')
  expect(await harness.client.request('test/state')).toMatchObject({
    queries: [{ sessionId: 'main', text: '/compact', delivery: 'queue' }], waitingCommands: 1,
  })
  await harness.client.request('test/release')
  const messages = await collect(session.receiveResponse())
  expect(messages.map(message => 'method' in message ? message.method : 'command')).toEqual([
    'session.event', 'session.event', 'command',
  ])
  expect(messages.at(-1)).toEqual({ commandId: 'command-1', result: { kind: 'success', text: 'compacted', sourceEventSeq: 0 } })
})

it('receives each pending prompt in FIFO order and forwards explicit steer delivery', async () => {
  const session = harnessWith().session('main')
  await session.query('first')
  await session.query('second', { delivery: 'steer' })
  const first = finalRun(await collect(session.receiveResponse()))
  const second = finalRun(await collect(session.receiveResponse()))
  expect(first.finalResponse).toBe('reply:first')
  expect(second.finalResponse).toBe('reply:second')
  expect(first.notifications[0]).toMatchObject({ params: { event: { type: 'agent/inbox/spliced', data: { target: 'next-turn' } } } })
  expect(second.notifications[0]).toMatchObject({ params: { event: { type: 'agent/inbox/spliced', data: { target: 'next-step' } } } })
  expect(first.events.some(event => event.type === 'assistant/message' && event.data.message.content.some(block =>
    block.type === 'text' && block.text === 'before receipt'))).toBe(false)
  expect(() => session.receiveResponse()).toThrow('No query')
})

it('keeps root result events separate from discovered descendant notifications', async () => {
  const session = harnessWith().session('main')
  await session.query('with-child')
  const messages = await collect(session.receiveResponse())
  const result = finalRun(messages)
  expect(result.finalResponse).toBe('reply:with-child')
  expect(result.notifications.some(notification => notification.params.sessionId === 'child')).toBe(true)
  expect(result.notifications.some(notification => notification.params.sessionId === 'unrelated')).toBe(false)
  expect(result.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
})

it('receives compact busy while an earlier receiver is still waiting for model activity', async () => {
  const harness = harnessWith()
  const session = harness.session('main')
  await session.query('hold')
  const running = collect(session.receiveResponse())
  await session.query('/compact')
  const command = await collect(session.receiveResponse())
  expect(command.at(-1)).toEqual({ commandId: 'command-2', result: { kind: 'error', text: 'busy' } })
  expect(await harness.client.request('test/state')).toMatchObject({ waitingPrompts: 1 })
  await harness.client.request('test/release')
  expect(finalRun(await running).finalResponse).toBe('reply:hold')
})

it('retains a rejection before reception without creating an unhandled rejected promise', async () => {
  const harness = harnessWith({ QUERY_ERROR_TEXT: 'reject this query' })
  const session = harness.session('main')
  await session.query('reject this query')
  await harness.client.request('test/state')
  await session.query('after rejection')
  await expect(collect(session.receiveResponse())).rejects.toThrow(JsonRpcResponseError)
  expect(finalRun(await collect(session.receiveResponse())).finalResponse).toBe('reply:after rejection')
})

it('accepts ordinary prompt routing for other slash input and preserves its text', async () => {
  const session = harnessWith().session('main')
  await session.query('/model')
  expect(finalRun(await collect(session.receiveResponse())).finalResponse).toBe('reply:/model')
  await session.query(' /compact extra ')
  expect(finalRun(await collect(session.receiveResponse())).finalResponse).toBe('reply: /compact extra ')
})

it('returns a valid command result even when the peer emits no lifecycle notifications', async () => {
  const execution = { commandId: 'command-no-events', result: { kind: 'success' } }
  const session = harnessWith({ QUERY_RESULT: JSON.stringify({ kind: 'command', execution }) }).session('main')
  await session.query('/compact')
  expect(await collect(session.receiveResponse())).toEqual([execution])
})

it('ends a command observation at its own done event when reception happens after another query', async () => {
  const harness = harnessWith()
  const session = harness.session('main')
  await session.query('/compact')
  await session.query('later')
  await harness.client.request('test/state')
  const command = await collect(session.receiveResponse())
  expect(command).toHaveLength(3)
  expect(command.at(-1)).toMatchObject({ commandId: 'command-1' })
  expect(finalRun(await collect(session.receiveResponse())).finalResponse).toBe('reply:later')
})

it('keeps a completed command result when the peer disconnects before reception', async () => {
  const harness = harnessWith()
  const session = harness.session('main')
  await session.query('/compact')
  await expect(harness.client.request('test/disconnect')).rejects.toThrow(TransportClosedError)
  const command = await collect(session.receiveResponse())
  expect(command).toHaveLength(3)
  expect(command.at(-1)).toMatchObject({ commandId: 'command-1', result: { kind: 'success', text: 'compacted' } })
})

it('captures notification collection failures before a command receiver consumes the outcome', async () => {
  const harness = harnessWith()
  const subscribe = harness.client.subscribeSessionTree.bind(harness.client)
  vi.spyOn(harness.client, 'subscribeSessionTree').mockImplementation((id) => {
    const subscription = subscribe(id)
    vi.spyOn(subscription, 'tryNext').mockImplementation(() => { throw new Error('notification collection failed') })
    return subscription
  })
  const session = harness.session('main')
  await session.query('/compact')
  await harness.client.request('test/state')
  await expect(collect(session.receiveResponse())).rejects.toThrow('notification collection failed')
})

it.each([
  null,
  {},
  { kind: 'unknown' },
  { kind: 'prompt' },
  { kind: 'prompt', messageId: '' },
  { kind: 'command', execution: { commandId: 'c', result: { kind: 'error' } } },
])('rejects malformed routing results on reception: %j', async (result) => {
  const session = harnessWith({ QUERY_RESULT: JSON.stringify(result) }).session('main')
  await session.query('input')
  await expect(collect(session.receiveResponse())).rejects.toThrow(SdkProtocolError)
})

it('abandons a receiver returned before its first next without cancelling the server operation', async () => {
  const harness = harnessWith({ QUERY_HOLD_COMMAND: '1' })
  const subscribed = vi.spyOn(harness.client, 'subscribeSessionTree')
  const session = harness.session('main')
  await session.query('/compact')
  const created = subscribed.mock.results[0]
  if (created?.type !== 'return') throw new Error('query did not create a subscription')
  const close = vi.spyOn(created.value, 'close')
  const receiver = session.receiveResponse()
  await receiver.return?.()
  expect(close).toHaveBeenCalled()
  expect(await receiver.next()).toEqual({ done: true, value: undefined })
  expect(await harness.client.request('test/state')).toMatchObject({ waitingCommands: 1 })
  await harness.client.request('test/release')
  await session.query('after abandonment')
  expect(finalRun(await collect(session.receiveResponse())).finalResponse).toBe('reply:after abandonment')
})

it.each(['hold', '/compact'])('return releases a pending next for %s without cancelling runtime work', async (text) => {
  const harness = harnessWith({ QUERY_HOLD_COMMAND: '1' })
  const subscribed = vi.spyOn(harness.client, 'subscribeSessionTree')
  const session = harness.session('main')
  await session.query(text)
  const waiting = Promise.withResolvers<undefined>()
  if (text === 'hold') {
    const created = subscribed.mock.results[0]
    if (created?.type !== 'return') throw new Error('query did not create a subscription')
    const subscription = created.value
    const next = subscription.next.bind(subscription)
    // Returning from a yielded buffered frame does not exercise cancellation of an actual read.
    vi.spyOn(subscription, 'next').mockImplementation(() => {
      const queued = subscription.tryNext()
      if (queued !== undefined) return Promise.resolve(queued)
      const result = next()
      waiting.resolve(undefined)
      return result
    })
  }
  const receiver = session.receiveResponse()
  const consuming = collect(receiver)
  if (text === 'hold') await waiting.promise
  else await harness.client.request('test/state')
  await receiver.return?.()
  await consuming
  expect(await harness.client.request('test/state')).toMatchObject(
    text === 'hold' ? { waitingPrompts: 1 } : { waitingCommands: 1 },
  )
  await harness.client.request('test/release')
})

it('ends a receiver closed during a pre-receipt read without yielding a RunResult', async () => {
  const harness = harnessWith()
  const subscribed = vi.spyOn(harness.client, 'subscribeSessionTree')
  const session = harness.session('main')
  await session.query('hold')
  const created = subscribed.mock.results[0]
  if (created?.type !== 'return') throw new Error('query did not create a subscription')
  const next = created.value.next.bind(created.value)
  const arrived = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  vi.spyOn(created.value, 'next').mockImplementationOnce(async () => {
    const notification = await next()
    arrived.resolve(undefined)
    await release.promise
    return notification
  })
  const receiver = session.receiveResponse()
  const receiving = receiver.next()
  await arrived.promise
  const returning = receiver.return?.()
  release.resolve(undefined)
  await expect(receiving).resolves.toEqual({ done: true, value: undefined })
  await expect(returning).resolves.toEqual({ done: true, value: undefined })
  expect(await harness.client.request('test/state')).toMatchObject({ waitingPrompts: 1 })
  await harness.client.request('test/release')
})

it('closes prompt subscriptions before yielding the final RunResult', async () => {
  const harness = harnessWith()
  const subscribed = vi.spyOn(harness.client, 'subscribeSessionTree')
  const session = harness.session('main')
  await session.query('complete')
  const created = subscribed.mock.results[0]
  if (created?.type !== 'return') throw new Error('query did not create a subscription')
  const close = vi.spyOn(created.value, 'close')
  const receiver = session.receiveResponse()
  while (true) {
    const item = await receiver.next()
    if (item.done) throw new Error('query ended without a RunResult')
    if (!('finalResponse' in item.value)) continue
    expect(close).toHaveBeenCalled()
    expect(item.value.finalResponse).toBe('reply:complete')
    break
  }
  await receiver.return?.()
})

it('reports local request timeout from the receiver and leaves the runtime responsive', async () => {
  const harness = harnessWith({ QUERY_HOLD_COMMAND: '1' }, 50)
  const session = harness.session('main')
  await session.query('/compact')
  await expect(collect(session.receiveResponse())).rejects.toThrow(RequestTimeoutError)
  expect(await harness.client.request('test/state', undefined, 5000)).toMatchObject({ waitingCommands: 1 })
})

it('reports runtime loss from the receiver', async () => {
  const session = harnessWith({ QUERY_DISCONNECT: '1' }).session('main')
  await session.query('disconnect')
  await expect(collect(session.receiveResponse())).rejects.toThrow(TransportClosedError)
})
