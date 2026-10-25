/** Unified input receipt and observation over an independently running protocol peer. */
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createProcessDeepSeekHarness } from '../src/api.ts'
import { JsonRpcResponseError, RequestTimeoutError, SdkProtocolError, TransportClosedError } from '../src/index.ts'
import type { CommandExecution, HarnessNotification, RunResult } from '../src/types.ts'

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

function activity(result: RunResult | CommandExecution): RunResult {
  if ('commandId' in result) throw new Error('expected ordinary prompt activity')
  return result
}

it.each(['session', 'harness'])('runs a native command through the %s entry without waiting for idle', async (entry) => {
  const harness = harnessWith()
  const notifications: HarnessNotification[] = []
  const onNotification = (notification: HarnessNotification): void => { notifications.push(notification) }
  const result = entry === 'session'
    ? await harness.session('main').run('/compact', { onNotification })
    : await harness.run('/compact', { sessionId: 'main', onNotification })
  expect(result).toEqual({ commandId: 'command-1', result: { kind: 'success', text: 'compacted', sourceEventSeq: 0 } })
  expect(notifications.map(notification => (notification.params.event as { type: string }).type))
    .toEqual(['command/run', 'command/done'])
})

it('preserves prompt text and observes its receipt-to-idle activity', async () => {
  const notifications: HarnessNotification[] = []
  const result = activity(await harnessWith().session('main').run(' first\n', {
    onNotification: (notification) => { notifications.push(notification) },
  }))
  expect(result.finalResponse).toBe('reply: first\n')
  expect(result.notifications).toEqual(notifications)
  expect(result.events.some(event => event.type === 'assistant/message' && event.data.message.content.some(block =>
    block.type === 'text' && block.text === 'before receipt'))).toBe(false)
})

it('steers ordinary text when delivery requests the next step', async () => {
  const result = activity(await harnessWith().session('main').run('next', { delivery: 'steer' }))
  expect(result.notifications[0]).toMatchObject({ params: { event: {
    type: 'agent/inbox/spliced', data: { target: 'next-step' },
  } } })
})

it('keeps root result events separate from descendant notifications', async () => {
  const result = activity(await harnessWith().session('main').run('with-child'))
  expect(result.finalResponse).toBe('reply:with-child')
  expect(result.notifications.some(notification => notification.params.sessionId === 'child')).toBe(true)
  expect(result.notifications.some(notification => notification.params.sessionId === 'unrelated')).toBe(false)
  expect(result.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
})

it('retains independent results for concurrent calls on one Session', async () => {
  const session = harnessWith().session('main')
  const results = await Promise.all([session.run('first'), session.run('second')])
  expect(results.map(result => activity(result).finalResponse)).toEqual(['reply:first', 'reply:second'])
})

it('returns a busy command result while another run waits for model activity', async () => {
  const harness = harnessWith()
  const session = harness.session('main')
  const entered = Promise.withResolvers<undefined>()
  const running = session.run('hold', { onNotification(notification) {
    if (notification.method === 'session.status' && notification.params.status === 'running') entered.resolve(undefined)
  } })
  await entered.promise
  expect(await session.run('/compact')).toEqual({ commandId: 'command-2', result: { kind: 'error', text: 'busy' } })
  await harness.client.request('test/release')
  expect(activity(await running).finalResponse).toBe('reply:hold')
})

it.each(['/model', ' /compact extra '])('preserves unsupported command input as text: %s', async (text) => {
  expect(activity(await harnessWith().session('main').run(text)).finalResponse).toBe(`reply:${text}`)
})

it('returns a command result without lifecycle notifications', async () => {
  const execution = { commandId: 'command-no-events', result: { kind: 'success' } }
  const notifications: HarnessNotification[] = []
  const result = await harnessWith({ QUERY_RESULT: JSON.stringify({ kind: 'command', execution }) }).session('main').run('/compact', {
    onNotification: (notification) => { notifications.push(notification) },
  })
  expect(result).toEqual(execution)
  expect(notifications).toEqual([])
})

it.each(['ordinary', '/compact'])('releases its subscription after an observer rejects %s', async (text) => {
  const harness = harnessWith()
  const subscribe = harness.client.subscribeSessionTree.bind(harness.client)
  const closes: ReturnType<typeof vi.fn>[] = []
  vi.spyOn(harness.client, 'subscribeSessionTree').mockImplementation((id) => {
    const subscription = subscribe(id)
    closes.push(vi.spyOn(subscription, 'close'))
    return subscription
  })
  await expect(harness.session('main').run(text, { onNotification() { throw new Error('observer failed') } }))
    .rejects.toThrow('observer failed')
  expect(closes[0]).toHaveBeenCalled()
  expect(activity(await harness.session('main').run('after')).finalResponse).toBe('reply:after')
})

it('propagates routing rejection without retrying as a prompt', async () => {
  const harness = harnessWith({ QUERY_ERROR_TEXT: 'reject this input' })
  await expect(harness.session('main').run('reject this input')).rejects.toThrow(JsonRpcResponseError)
  expect(await harness.client.request('test/state')).toMatchObject({ methods: ['initialize', 'session/query', 'test/state'] })
})

it.each([
  null,
  {},
  { kind: 'unknown' },
  { kind: 'prompt' },
  { kind: 'prompt', messageId: '' },
  { kind: 'command', execution: { commandId: 'c', result: { kind: 'error' } } },
])('rejects malformed routing results: %j', async (result) => {
  await expect(harnessWith({ QUERY_RESULT: JSON.stringify(result) }).session('main').run('input'))
    .rejects.toThrow(SdkProtocolError)
})

it('reports command timeout without cancelling the runtime operation', async () => {
  const harness = harnessWith({ QUERY_HOLD_COMMAND: '1' }, 50)
  await expect(harness.session('main').run('/compact')).rejects.toThrow(RequestTimeoutError)
  expect(await harness.client.request('test/state', undefined, 5000)).toMatchObject({ waitingCommands: 1 })
  await harness.client.request('test/release', undefined, 5000)
})

it('reports runtime loss from run', async () => {
  await expect(harnessWith({ QUERY_DISCONNECT: '1' }).session('main').run('disconnect')).rejects.toThrow(TransportClosedError)
})

it('rejects steer delivery for literal content blocks', async () => {
  await expect(harnessWith().session('main').run([{ type: 'text', text: 'literal' }], { delivery: 'steer' }))
    .rejects.toThrow('content-block input requires queue delivery')
})
