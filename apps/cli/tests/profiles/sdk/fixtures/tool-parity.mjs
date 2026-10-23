/** Observe step-admitted capabilities without changing either shipped tool executor. */
import { writeFile } from 'node:fs/promises'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const inject = ['tools', 'agents', 'loader']

export function apply(ctx, config) {
  let observed
  let writes = Promise.resolve()
  const members = new Map()
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    if (context.toolSet !== undefined) {
      const names = ctx.tools.definitions(context.scope, context.toolSet).map(tool => tool.name).sort()
      const membership = config.team ? ctx.get('agentTeams').membership(context.scope) : undefined
      if (membership !== undefined) members.set(membership.role, {
        role: membership.role, sessionId: context.scope.id,
        parentSession: context.scope.session.header.parentSession, names,
      })
      observed = {
        names: membership?.role === 'teammate' ? observed.names : names,
        hmr: ctx.get('hmr') !== undefined,
        members: [...members.values()],
      }
      const serialized = JSON.stringify(observed)
      writes = writes.then(() => writeFile(config.output, serialized))
      await writes
    }
    return next()
  })
  if (config.team) {
    const spawned = new Set()
    // A completed teammate can leave the registry before spawnTeammate's persistence barrier settles.
    const created = new Map()
    ctx.on('agent/created', ({ agent }) => { created.set(agent.id, agent) })
    ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
      const teams = ctx.get('agentTeams')
      if (teams.membership(agent).role !== 'lead' || spawned.has(agent)) return
      spawned.add(agent)
      const { member } = await teams.spawnTeammate(agent, {
        name: 'parity-worker', description: 'Inspect teammate tools',
        prompt: [{ type: 'text', text: 'Inspect teammate tools' }], context: 'fresh', provider: 'spawn', signal,
      })
      const child = created.get(member.id)
      if (child === undefined) throw new Error('Team service created no live teammate')
      await child.whenIdle()
      await writes
    })
  }
  if (config.preset === undefined) return
  const receive = message => {
    if (message === 'stop-tool-parity') {
      process.emit('SIGTERM')
      return
    }
    if (message !== 'collect-tool-parity') return
    void collect().then(
      result => process.send({ result }),
      error => process.send({ error: String(error.stack ?? error) }),
    )
  }
  ctx.effect(() => {
    process.on('message', receive)
    return () => process.off('message', receive)
  })
  async function collect() {
    await ctx.loader.await()
    const presets = ctx.get('agentPresets')
    if (presets === undefined) throw new Error('Web tool parity requires the shipped presets')
    const handle = await ctx.agents.create({
      sessionId: 'tool-parity', cwd: config.cwd,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      setup: scope => presets.mount(scope, config.preset).then(() => undefined),
    })
    try {
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect tools' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      if (observed === undefined) throw new Error('Web did not assemble a model step')
      return observed
    } finally {
      await handle.dispose()
    }
  }
}
