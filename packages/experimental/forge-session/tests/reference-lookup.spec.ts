/** Reference observation over the real service graph with a platform-independent shell provider. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { pluginRecordOf, SessionId } from '@deepseek-ai/dsh-session'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellRunResult } from '@deepseek-ai/dsh-shell'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import { commandEvidence } from '../src/commands.ts'
import { bench, pullUrl } from './fixtures.ts'

function output(overrides: Partial<ShellRunResult> = {}): ShellRunResult {
  return { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000,
    stdout: { text: JSON.stringify({ url: pullUrl(9) }), truncated: false },
    stderr: { text: '', truncated: false }, ...overrides }
}

function execution(result: () => Promise<ShellRunResult>): ShellExecution {
  const reader = { readFrom: (offset: number) => ({ text: '', nextOffset: offset, lossy: false }) }
  return { status: 'completed', exitCode: 0, signal: null, done: Promise.resolve(undefined),
    readOutput: () => ({ delta: '', lossy: false }), observed: { stdout: reader, stderr: reader },
    kill: () => false, result }
}

class ScriptedShell extends ShellExecutor {
  readonly seen: ShellExecSpec[] = []
  run: (spec: ShellExecSpec) => Promise<ShellExecution> = () => Promise.resolve(execution(() => Promise.resolve(output())))

  resolve(request: ShellExecRequest): ShellExecSpec {
    return { command: request.command, workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? 1000, onExpiry: 'kill', stdoutMaxBytes: 4096,
      signal: request.signal, dshEnv: request.dshEnv, sandboxPolicy: request.sandboxPolicy }
  }

  execute(spec: ShellExecSpec): Promise<ShellExecution> {
    this.seen.push(spec)
    return this.run(spec)
  }
}

async function fixture(test: { onTestFinished: (cleanup: () => Promise<void>) => void }, policy = false) {
  const f = await bench()
  const root = await mkdtemp(join(tmpdir(), 'forge-reference-')).catch(async (error: unknown) => {
    await f.ctx.fiber.dispose()
    throw error
  })
  test.onTestFinished(async () => {
    try { await f.ctx.fiber.dispose() }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  const ctx = f.ctx
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(WorkingDirectoryService)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (policy) await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: root })
  await ctx.plugin(ShellEnv, { dshHome: root })
  await ctx.plugin(ScriptedShell)
  await ctx.fiber.await()
  const handle = await ctx.agents.create({ sessionId: SessionId('reference-observer') })
  const controller = new AbortController()
  const exec: ToolExecution = {
    name: 'bash', agent: handle.agent, callId: ToolCallId('reference'), rootCallId: ToolCallId('reference'),
    token: Symbol('reference') as ToolExecutionToken,
    arguments: { command: 'gh pr view 9 -R octo/demo --json number' }, signal: controller.signal,
  }
  const result: ToolExecutionResult = { isError: false, content: [{ type: 'text', text: '{"number":9}' }],
    value: { kind: 'foreground', cwd: root, exitCode: 0, signal: null, timedOut: false, aborted: false } }
  const records = () => handle.agent.session.snapshotEvents().flatMap((event) => {
    const record = pluginRecordOf(event)
    return record?.type === 'plugin:forge-session/binding' ? [record.data] : []
  })
  return { ...f, root, exec, result, controller, records, shell: ctx.shell as ScriptedShell }
}

it('records confirmed URLs once, preserving the execution world and policy', async (test) => {
  const f = await fixture(test, true)
  f.shell.run = spec => Promise.resolve(execution(() => Promise.resolve(output({
    stdout: { text: JSON.stringify({ url: pullUrl(spec.command.includes('10') ? 10 : 9) }), truncated: false },
  }))))
  f.ctx.emit('tools/result', f.exec, f.result)
  await vi.waitFor(() => { expect(f.records()).toEqual([{ action: 'reference', url: pullUrl(9) }]) })
  f.ctx.emit('tools/result', f.exec, f.result)
  f.ctx.emit('tools/result', { ...f.exec, arguments: { command: 'gh pr view 10 -R octo/demo' } }, f.result)
  await vi.waitFor(() => { expect(f.records()).toEqual([
    { action: 'reference', url: pullUrl(9) }, { action: 'reference', url: pullUrl(10) },
  ]) })
  expect(f.shell.seen).toHaveLength(3)
  expect(f.shell.seen[0]).toMatchObject({ workdir: f.root, sandboxPolicy: { mode: 'workspace-write' } })
  expect(commandEvidence('gh pr view 9 -R octo/demo')).toEqual({ urls: 'referenced', pushes: false, named: [] })
})

it('ignores incomplete, nested, unrelated and already-resolved results', async (test) => {
  const f = await fixture(test)
  const emit = (exec: ToolExecution, result: ToolExecutionResult = f.result) => { f.ctx.emit('tools/result', exec, result) }
  emit({ ...f.exec, name: 'pwsh' })
  const { agent: _agent, ...withoutAgent } = f.exec
  emit(withoutAgent)
  emit({ ...f.exec, parent: f.exec.token })
  emit(f.exec, { isError: true, error: { message: 'failed' }, content: [] })
  emit({ ...f.exec, arguments: {} })
  emit(f.exec, { isError: false, value: { kind: 'background' }, content: [] })
  emit({ ...f.exec, arguments: { command: 'gh pr view 9' } }, { ...f.result, content: [{ type: 'reasoning', text: 'thinking' }] })
  emit({ ...f.exec, arguments: { command: `gh pr view ${pullUrl(9)}` } })
  emit(f.exec, { ...f.result, content: [{ type: 'text', text: pullUrl(9) }] })
  f.controller.abort()
  emit(f.exec)
  await f.service.dispose()
  expect(f.shell.seen).toEqual([])
  expect(f.records()).toEqual([])
})

it.for(['exit', 'signal', 'timeout', 'abort', 'truncated', 'json', 'url', 'prepare'] as const)(
  'reports %s lookup failure without changing the completed tool result', async (kind, test) => {
    const f = await fixture(test)
    const reported = Promise.withResolvers<undefined>()
    const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => { reported.resolve(undefined) })
    f.shell.run = async () => {
      if (kind === 'prepare') throw 'preparation unavailable'
      return execution(() => Promise.resolve(output({
        ...kind === 'exit' ? { exitCode: 1 } : {},
        ...kind === 'signal' ? { signal: 'SIGTERM' } : {},
        ...kind === 'timeout' ? { timedOut: true } : {},
        ...kind === 'abort' ? { aborted: true } : {},
        stdout: { text: kind === 'json' ? '{' : kind === 'url' ? '{}' : JSON.stringify({ url: pullUrl(9) }),
          truncated: kind === 'truncated' },
      })))
    }
    f.ctx.emit('tools/result', f.exec, f.result)
    await reported.promise
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('PR reference lookup failed'))
    expect(f.records()).toEqual([])
    expect(f.result.isError).toBe(false)
  })

it.for(['caller', 'service'] as const)('awaits an in-flight lookup on %s cancellation', async (owner, test) => {
  const f = await fixture(test)
  const started = Promise.withResolvers<undefined>()
  const stopped = Promise.withResolvers<undefined>()
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  f.shell.run = async spec => execution(() => new Promise((resolve) => {
    spec.signal!.addEventListener('abort', () => { stopped.resolve(undefined); resolve(output({ aborted: true })) }, { once: true })
    started.resolve(undefined)
  }))
  f.ctx.emit('tools/result', f.exec, f.result)
  await started.promise
  if (owner === 'caller') f.controller.abort()
  await f.service.dispose()
  await stopped.promise
  expect(f.records()).toEqual([])
  expect(warn).not.toHaveBeenCalled()
})

it('contains a cancelled preparation failure without recording a binding', async (test) => {
  const f = await fixture(test)
  const entered = Promise.withResolvers<undefined>()
  const pending = Promise.withResolvers<ShellExecution>()
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  f.shell.run = () => { entered.resolve(undefined); return pending.promise }
  f.ctx.emit('tools/result', f.exec, f.result)
  await entered.promise
  f.controller.abort()
  pending.reject(new Error('cancelled during preparation'))
  await f.service.dispose()
  expect(f.records()).toEqual([])
  expect(warn).not.toHaveBeenCalled()
})
