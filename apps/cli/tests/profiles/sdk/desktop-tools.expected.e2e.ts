/**
 * Keyless comparison of actual SDK and Desktop/Web step-admitted tool sets.
 * Runs in test:expected, hence ci-consumers and PR all checks passed, after the build.
 * Keep intentional differences in tool-parity.ts; unused exceptions fail.
 * Standard/PTC compare both the default root and real Team Lead/teammate scopes.
 * SDK minimal, Creator-only tools, graphical context and optional runtime payloads are excluded.
 */
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { z } from 'zod'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { initProfile } from '@deepseek-ai/dsh-app-boot'
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-official-bundles'
import { expect, it, type TestContext } from 'vitest'
import { clearAmbientProxyEnv } from '../../../../../scripts/test-proxy-environment.ts'
import { messagesResponse } from './fixtures/messages-response.ts'
import { assertToolParity, toolParityExceptions, type ToolMode } from './tool-parity.ts'

const repo = fileURLToPath(new URL('../../../../../', import.meta.url))
const observer = new URL('./fixtures/tool-parity.mjs', import.meta.url).href
const probe = new URL('./fixtures/parity-probe.mjs', import.meta.url).href
const memberSchema = z.object({
  role: z.enum(['lead', 'teammate']), sessionId: z.string(), parentSession: z.string().optional(),
  names: z.array(z.string()).min(1),
})
const inventorySchema = z.object({ names: z.array(z.string()).min(1), hmr: z.boolean(), members: z.array(memberSchema) })
type Inventory = z.infer<typeof inventorySchema>

async function fixture(test: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sdk-desktop-tools-'))
  const requests: { tools: { name: string }[] }[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body) as { tools: { name: string }[] })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(messagesResponse({ type: 'text', text: 'tools inspected' }, 'end_turn'))
    })
  })
  test.onTestFinished(async () => {
    try {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      }))
    }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('model fixture has no TCP address')
  // No ambient DSH options, runtime payload, MCP profile, or personal skill directory enters this comparison.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_')))
  Object.assign(env, {
    DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_DISABLED: '1',
    DSH_AGENTS_HOME: join(root, 'agents'), DSH_PRIMARY_RUNTIME: '',
    DEEPSEEK_API_KEY: 'keyless-parity', DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
    NODE_OPTIONS: '', NODE_PATH: '',
  })
  clearAmbientProxyEnv(env)

  async function collect(side: 'sdk' | 'desktop', mode: ToolMode, mutations: object[] = [], team = false): Promise<Inventory> {
    const cwd = await mkdtemp(join(root, `${side}-${mode}-`))
    const home = join(cwd, 'home')
    if (team) {
      const profile = side === 'sdk' ? 'sdk' : 'web'
      initProfile(join(home, 'profiles', profile), [
        ...PROFILE_TEMPLATES[profile]!.bundles, '@deepseek-ai/dsh-experimental-agent-team-profile',
      ])
    }
    const output = join(cwd, 'tools.json')
    const patch = join(cwd, 'observer.patch.yml')
    await writeFile(patch, JSON.stringify([
      { id: 'session-title-llm', disabled: true },
      { insert: [{ id: 'tool-parity-observer', name: observer,
        config: { output, cwd, team, ...(side === 'desktop' ? { preset: mode } : {}) } }] },
      ...mutations,
    ]))
    const before = requests.length
    let inventory: Inventory
    if (side === 'sdk') {
      const harness = new DeepSeekHarness({
        cwd, processCwd: cwd, dshHome: home, env, model: 'deepseek-v4-pro',
        patches: [...mode === 'ptc' ? [join(repo, 'apps/cli/config/examples/ptc.yml')] : [], patch],
      })
      const abort = (): void => { void harness.close() }
      test.signal.addEventListener('abort', abort, { once: true })
      try {
        const result = await harness.session('tool-parity').run('Inspect tools')
        expect(result.finalResponse).toBe('tools inspected')
        inventory = inventorySchema.parse(JSON.parse(await readFile(output, 'utf8')))
      } finally {
        await harness.close()
        test.signal.removeEventListener('abort', abort)
      }
      expect(inventory.hmr).toBe(false)
    } else {
      const child = execa(process.execPath, [join(repo, 'apps/cli/lib/bin.js'), '--profile', 'web',
        '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
        cwd, env: { ...env, DSH_HOME: home }, extendEnv: false,
        ipc: true, stdin: 'ignore', reject: false, cancelSignal: test.signal, forceKillAfterDelay: 10_000,
      })
      let stdout = ''
      let stderr = ''
      const ready = Promise.withResolvers<true>()
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        if (stdout.includes('dsh web: http://')) ready.resolve(true)
      })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      void child.then((result) => { ready.reject(new Error(`Web exited: ${result.exitCode}\n${stderr}`)) })
      try {
        await ready.promise
        const reply = child.getOneMessage()
        await child.sendMessage('collect-tool-parity')
        const message = z.object({ result: inventorySchema.optional(), error: z.string().optional() }).parse(await reply)
        if (message.error !== undefined) throw new Error(message.error)
        inventory = inventorySchema.parse(message.result)
      } catch (error) {
        throw new Error(`Web collection failed\n${stdout}\n${stderr}`, { cause: error })
      } finally {
        // Ask the CLI to drain on Windows too, where an OS signal kills immediately.
        const watchdog = setTimeout(() => { child.kill('SIGKILL') }, 10_000)
        try {
          try { await child.sendMessage('stop-tool-parity') }
          catch (_closedChannel: unknown) { child.kill('SIGTERM') }
          const result = await child
          expect(result.exitCode, result.stderr).toBe(0)
          expect(result.signal, result.stderr).toBeUndefined()
        } finally { clearTimeout(watchdog) }
      }
      expect(inventory.hmr).toBe(true)
    }
    expect(requests.length).toBeGreaterThan(before)
    const presented = requests.slice(before).map(request => request.tools.map(tool => tool.name).sort())
    if (mode === 'ptc') {
      for (const names of presented) expect(names).toEqual(['run_code'])
    } else {
      expect(presented).toContainEqual(inventory.names)
      for (const member of inventory.members) expect(presented).toContainEqual(member.names)
    }
    if (team) {
      expect(inventory.members.map(member => member.role).sort()).toEqual(['lead', 'teammate'])
      const lead = inventory.members.find(member => member.role === 'lead')!
      const teammate = inventory.members.find(member => member.role === 'teammate')!
      expect(lead.parentSession).toBeUndefined()
      expect(teammate.parentSession).toBe(lead.sessionId)
      expect(teammate.sessionId).not.toBe(lead.sessionId)
    } else expect(inventory.members).toEqual([])
    return inventory
  }
  return collect
}

it.for(['standard', 'ptc'] as const)('compares the shipped %s tool sets and detects one-sided profile edits', async (mode, test) => {
  const collect = await fixture(test)
  const sdk = await collect('sdk', mode)
  const desktop = await collect('desktop', mode)
  assertToolParity(mode, sdk.names, desktop.names)
  expect(sdk.names).toContain('plugin_manager')
  const optOut = await collect('sdk', mode, [{ id: 'tool-plugin-manager', disabled: true }])
  expect(optOut.names).not.toContain('plugin_manager')
  expect(() => { assertToolParity(mode, optOut.names, desktop.names) }).toThrow('plugin_manager')
  for (const [id, tool] of [['present', 'present'], ['tool-ask-user', 'ask_user_question'], ['tool-schedule', 'schedule_create']]) {
    const missing = await collect('sdk', mode, [{ id, disabled: true }])
    expect(() => { assertToolParity(mode, missing.names, desktop.names) }).toThrow(new RegExp(`Missing from SDK:.*${tool}`))
  }
  const addition = [{ insert: [{ id: 'parity-probe', name: probe }] }]
  const desktopExtra = await collect('desktop', mode, addition)
  expect(() => { assertToolParity(mode, sdk.names, desktopExtra.names) }).toThrow('Missing from SDK: parity_probe')
  const sdkExtra = await collect('sdk', mode, addition)
  expect(() => { assertToolParity(mode, sdkExtra.names, desktop.names) }).toThrow('Only in SDK: parity_probe')
  assertToolParity(mode, sdkExtra.names, desktopExtra.names)
})

it.for(['standard', 'ptc'] as const)('compares real Team Lead and teammate tool sets in %s', async (mode, test) => {
  const collect = await fixture(test)
  const sdk = await collect('sdk', mode, [], true)
  const desktop = await collect('desktop', mode, [], true)
  const exceptions = toolParityExceptions[mode].filter(exception => exception.tool !== 'list_subagent_models')
  for (const role of ['lead', 'teammate'] as const) {
    const sdkMember = sdk.members.find(member => member.role === role)!
    const desktopMember = desktop.members.find(member => member.role === role)!
    expect(sdkMember.names).toContain('spawn_teammate')
    expect(desktopMember.names).toContain('spawn_teammate')
    for (const names of [sdkMember.names, desktopMember.names]) {
      for (const retired of ['subagent', 'subagent_fork', 'list_subagent_models']) expect(names).not.toContain(retired)
    }
    assertToolParity(mode, sdkMember.names, desktopMember.names, exceptions, `Team ${role}`)
  }
  const missing = await collect('sdk', mode, [{ id: 'tool-agent-team', disabled: true }], true)
  const addition = [{ insert: [{ id: 'parity-probe', name: probe }] }]
  const desktopExtra = await collect('desktop', mode, addition, true)
  const sdkExtra = await collect('sdk', mode, addition, true)
  for (const role of ['lead', 'teammate'] as const) {
    const names = (inventory: Inventory) => inventory.members.find(member => member.role === role)!.names
    expect(() => {
      assertToolParity(mode, names(missing), names(desktop), exceptions, `Team ${role}`)
    }).toThrow(new RegExp(`Team ${role}[\\s\\S]*Missing from SDK:.*spawn_teammate`))
    expect(() => {
      assertToolParity(mode, names(sdk), names(desktopExtra), exceptions, `Team ${role}`)
    }).toThrow('Missing from SDK: parity_probe')
    assertToolParity(mode, names(sdkExtra), names(desktopExtra), exceptions, `Team ${role}`)
  }
})
