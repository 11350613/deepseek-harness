import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime, { type CommandDefinition, type CommandInvocation } from '@deepseek-ai/dsh-commands'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { HarnessSdkJsonRpcServer } from '../src/server.ts'

class UnusedModel extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(): AsyncIterable<StreamChunk> {
    throw new Error('Command dispatch must not call the model')
  }
}

class TextModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function setup(registry = true) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const loop = await ctx.plugin(AgentLoop, { agents: [] })
  if (registry) await ctx.plugin(CommandRuntime)
  ctx.llm.registerAdapter(['mock'], new UnusedModel())
  const transport: JsonRpcTransportPeer = {
    request: async () => { throw new Error('Unexpected runtime request') },
    notify: () => {},
  }
  const server = new HarnessSdkJsonRpcServer(ctx, transport)
  onTestFinished(async () => { await server.shutdown() })
  const initialize = () => server.initialize({ cwd: process.cwd(), provider: 'mock', model: 'mock' })
  const register = (handler: CommandDefinition['handler']) => {
    ctx.effect(() => ctx.commands.register({ name: 'compact', description: 'Fixture command', handler }))
  }
  const command = () => server.executeCommand({ sessionId: SessionId('commands'), line: '/compact' })
  return { ctx, server, loop, initialize, register, command }
}

describe('SDK command dispatch', () => {
  it.each(['success', 'error'] as const)('returns the logged native %s without a model turn', async (kind) => {
    const h = await setup()
    await h.initialize()
    const handler = vi.fn((_invocation: CommandInvocation) => ({ kind, text: 'native outcome' }))
    h.register(handler)
    const execution = await h.command()
    const agent = h.ctx.agents.get(SessionId('commands'))!
    expect(handler).toHaveBeenCalledOnce()
    const invocation = handler.mock.calls[0]![0]
    expect(invocation.agent.id).toBe(agent.id)
    expect(invocation.rawInput).toBe('')
    expect(invocation.attachments).toEqual([])
    expect(execution.result).toEqual({ kind, text: 'native outcome' })
    expect(agent.session.snapshotEvents().map(event => event.type)).toEqual(['command/run', 'command/done'])
    expect(agent.session.snapshotEvents().map(event => event.data)).toEqual([
      { commandId: execution.commandId, name: 'compact', args: '', source: { kind: 'user' } },
      { commandId: execution.commandId, kind, text: 'native outcome' },
    ])
  })

  it.each([undefined, {}, { sessionId: '' }, { sessionId: 's', line: 1 },
    { sessionId: 's', line: '/compact', attachments: [] }])('rejects malformed wire parameters %j before creating a Session', async (params) => {
    const h = await setup()
    await h.initialize()
    await expect(h.server.handleRequest('session/command', params)).rejects.toThrow('requires only')
    expect(h.ctx.agents.list()).toEqual([])
  })

  it.each(['text', '/model', '/unknown', '/permission', '/permission \t\n'])('rejects unsupported input %s without invoking another command', async (line) => {
    const h = await setup()
    await h.initialize()
    const handler = vi.fn(() => ({ kind: 'success' as const }))
    h.register(handler)
    await expect(h.server.handleRequest('session/command', { sessionId: 's', line })).rejects.toThrow('only /compact')
    expect(handler).not.toHaveBeenCalled()
    expect(h.ctx.agents.list()).toEqual([])
  })

  it('requires initialization and the composed registry and command', async () => {
    const absent = await setup(false)
    await expect(absent.command()).rejects.toThrow('not initialized')
    await absent.initialize()
    await expect(absent.command()).rejects.toThrow('Commands are unavailable')
    const empty = await setup()
    await empty.initialize()
    await expect(empty.command()).rejects.toThrow('/compact is unavailable')
    await expect(empty.server.executeCommand({ sessionId: SessionId('commands'), line: '/permission read-only' }))
      .rejects.toThrow('/permission is unavailable')
  })

  it.each(['strict', 'query'] as const)('passes explicit permission input to the native handler through %s', async (entry) => {
    const h = await setup()
    await h.initialize()
    const handler = vi.fn((_invocation: CommandInvocation) => ({ kind: 'error' as const, text: 'native preset refusal' }))
    h.ctx.effect(() => h.ctx.commands.register({ name: 'permission', description: 'Fixture permission', input: { hint: 'Preset' }, handler }))
    const sessionId = SessionId('permission')
    const line = '/permission  deployment-preset'
    const result = entry === 'strict'
      ? await h.server.executeCommand({ sessionId, line })
      : await h.server.query({ sessionId, text: line, delivery: 'steer' })
    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0]![0].rawInput).toBe('  deployment-preset')
    const expected = { result: { kind: 'error', text: 'native preset refusal' } }
    expect(result).toMatchObject(entry === 'strict' ? expected : { kind: 'command', execution: expected })
    expect(h.ctx.agents.get(sessionId)!.session.snapshotEvents().map(event => event.type))
      .toEqual(['command/run', 'command/done'])
  })

  it.each(['/plan', '/plan off', '/plan  explain the change'])('delegates %s without reconstructing model input', async (line) => {
    const h = await setup()
    await h.initialize()
    const handler = vi.fn((_invocation: CommandInvocation) => ({ kind: 'success' as const, text: 'native plan result' }))
    h.ctx.effect(() => h.ctx.commands.register({ name: 'plan', description: 'Plan', input: { hint: '[off|message]' }, handler }))
    const result = await h.server.query({ sessionId: SessionId('plan'), text: line, delivery: 'queue' })
    expect(result).toMatchObject({ kind: 'command', execution: { result: { kind: 'success', text: 'native plan result' } } })
    expect(handler.mock.calls[0]![0].rawInput).toBe(line.slice('/plan'.length))
    expect(h.ctx.agents.get(SessionId('plan'))!.session.snapshotEvents().map(event => event.type))
      .toEqual(['command/run', 'command/done'])
  })

  it('passes arguments unchanged and propagates handler failures', async () => {
    const h = await setup()
    await h.initialize()
    h.register(({ rawInput }) => { throw new Error(`handler saw:${rawInput}`) })
    await expect(h.server.handleRequest('session/command', { sessionId: 'commands', line: '/compact  extra' }))
      .rejects.toThrow('handler saw:  extra')
    expect(h.ctx.agents.get(SessionId('commands'))!.session.snapshotEvents().at(-1)?.type).toBe('command/done')
  })

  it('rejects a disposed Agent retained by the SDK handle', async () => {
    const h = await setup()
    await h.initialize()
    h.register(() => ({ kind: 'success' }))
    await h.command()
    await h.loop.dispose()
    await expect(h.command()).rejects.toThrow('disposed outside the server')
    await expect(h.server.query({ sessionId: SessionId('commands'), text: '/compact', delivery: 'queue' }))
      .rejects.toThrow('disposed outside the server')
  })

  it('cancels an in-flight command on shutdown and rejects later admission', async () => {
    const h = await setup()
    await h.initialize()
    const entered = Promise.withResolvers<undefined>()
    const cancelled = vi.fn()
    h.register(({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { cancelled(); reject(new Error('fixture command aborted')) }, { once: true })
      entered.resolve(undefined)
    }))
    const execution = h.command()
    const rejected = expect(execution).rejects.toThrow('shutting down')
    await entered.promise
    await expect(h.server.getWorkingDirectory({ sessionId: 'commands' })).resolves.toHaveProperty('cwd')
    await h.server.shutdown()
    await rejected
    expect(cancelled).toHaveBeenCalledOnce()
    expect(h.ctx.agents.list()).toEqual([])
    await expect(h.command()).rejects.toThrow('shutting down')
  })

  it.each(['command', 'query-command', 'query-prompt'] as const)('does not execute %s while its Session is being created at shutdown', async (entry) => {
    const h = await setup()
    await h.initialize()
    const handler = vi.fn(() => ({ kind: 'success' as const }))
    h.register(handler)
    const created = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const create = h.ctx.agents.create.bind(h.ctx.agents)
    vi.spyOn(h.ctx.agents, 'create').mockImplementation(async (request) => {
      const handle = await create(request)
      created.resolve(undefined)
      await release.promise
      return handle
    })
    const execution = entry === 'command' ? h.command()
      : h.server.query({ sessionId: SessionId('commands'), text: entry === 'query-command' ? '/compact' : 'ordinary input', delivery: 'queue' })
    const rejected = expect(execution).rejects.toThrow('shutting down')
    await created.promise
    const shutdown = h.server.shutdown()
    release.resolve(undefined)
    await Promise.all([rejected, shutdown])
    expect(handler).not.toHaveBeenCalled()
    expect(h.ctx.agents.list()).toEqual([])
  })
})

describe('SDK query dispatch', () => {
  it.each([undefined, {}, { sessionId: '', text: 'go', delivery: 'queue' },
    { sessionId: 'q', text: '', delivery: 'queue' }, { sessionId: 'q', text: '  ', delivery: 'queue' },
    { sessionId: 'q', text: 'go', delivery: 'later' },
    { sessionId: 'q', text: 'go', delivery: 'queue', permission: 'full' }])('rejects invalid query fields %j', async (params) => {
    const h = await setup()
    await h.initialize()
    await expect(h.server.handleRequest('session/query', params)).rejects.toThrow('session/query requires only')
    expect(h.ctx.agents.list()).toEqual([])
  })

  it.each(['/compact', '/permission read-only'])('preserves %s without a command registry and requires a live initialized server', async (text) => {
    const h = await setup(false)
    const params = { sessionId: SessionId('q'), text, delivery: 'queue' as const }
    await expect(h.server.query(params)).rejects.toThrow('not initialized')
    const model = new TextModel()
    h.ctx.effect(() => h.ctx.llm.registerAdapter(['query-model'], model))
    await h.server.initialize({ cwd: process.cwd(), provider: 'query-model', model: 'model' })
    await expect(h.server.query(params)).resolves.toMatchObject({ kind: 'prompt' })
    await h.server.wait({ sessionId: 'q' })
    expect(model.requests).toHaveLength(1)
    await h.server.shutdown()
    await expect(h.server.query(params)).rejects.toThrow('shutting down')
  })

  it('returns the native command result without creating a prompt', async () => {
    const h = await setup()
    await h.initialize()
    h.register(() => ({ kind: 'error', text: 'native refusal' }))
    const response = await h.server.handleRequest('session/query', {
      sessionId: 'q', text: ' \n/compact\t ', delivery: 'queue',
    })
    expect(response).toMatchObject({ kind: 'command', execution: { result: { kind: 'error', text: 'native refusal' } } })
    expect(h.ctx.agents.get(SessionId('q'))!.session.snapshotEvents().map(event => event.type))
      .toEqual(['command/run', 'command/done'])
  })

  it.each(['ordinary text', '/unknown', ' \n/compact extra\t '])('preserves unclaimed query text %j', async (text) => {
    const h = await setup()
    h.register(() => { throw new Error('Must not execute a command') })
    const model = new TextModel()
    h.ctx.effect(() => h.ctx.llm.registerAdapter(['query-model'], model))
    await h.server.initialize({ cwd: process.cwd(), provider: 'query-model', model: 'model' })
    expect(await h.server.query({ sessionId: SessionId('q'), text, delivery: 'queue' })).toMatchObject({ kind: 'prompt' })
    await h.server.wait({ sessionId: 'q' })
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]!.messages.some(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text === text))).toBe(true)
    expect(h.ctx.agents.get(SessionId('q'))!.session.snapshotEvents().some(event => event.type === 'command/run')).toBe(false)
  })

  it('delivers a steer query through the existing Agent operation', async () => {
    const h = await setup()
    await h.initialize()
    h.register(() => ({ kind: 'success' }))
    await h.command()
    const agent = h.ctx.agents.get(SessionId('commands'))!
    const steer = vi.spyOn(agent, 'steer').mockImplementation(() => {})
    const queued = vi.spyOn(agent, 'followup').mockImplementation(() => {})
    const result = await h.server.query({ sessionId: SessionId('commands'), text: 'next step', delivery: 'steer' })
    expect(result).toMatchObject({ kind: 'prompt' })
    expect(steer).toHaveBeenCalledWith(expect.objectContaining({ content: [{ type: 'text', text: 'next step' }] }))
    expect(queued).not.toHaveBeenCalled()
  })

  it.each(['/feedback inspect', '/model', '/file', '/export', '/permission', ' \n/权限\t '])('preserves existing prompt behavior for unimplemented input %s', async (text) => {
    const h = await setup()
    const model = new TextModel()
    h.ctx.effect(() => h.ctx.llm.registerAdapter(['query-model'], model))
    await h.server.initialize({ cwd: process.cwd(), provider: 'query-model', model: 'model' })
    const handler = vi.fn(() => ({ kind: 'success' as const }))
    h.ctx.effect(() => h.ctx.commands.register({ name: 'feedback', description: 'Feedback', input: { hint: 'Task' }, handler }))
    h.ctx.effect(() => h.ctx.commands.register({ name: 'permission', description: 'Permission', input: { hint: 'Preset' }, handler }))
    await expect(h.server.query({ sessionId: SessionId('q'), text, delivery: 'queue' })).resolves.toMatchObject({ kind: 'prompt' })
    await h.server.wait({ sessionId: 'q' })
    expect(handler).not.toHaveBeenCalled()
    expect(model.requests[0]!.messages.some(message => message.content.some(block => block.type === 'text' && block.text === text))).toBe(true)
    expect(h.ctx.agents.get(SessionId('q'))!.session.snapshotEvents().some(event => event.type === 'command/run')).toBe(false)
  })
})
