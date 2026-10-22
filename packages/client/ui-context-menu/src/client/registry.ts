/** Ordered menu resolution with cancellation and contribution-owned action lifetimes. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MenuAction, MenuActionView, MenuContribution, MenuResolution, MenuTarget, MenuTargetMap } from './types.ts'

interface Provider {
  readonly id: string
  readonly order: number
  readonly kind: keyof MenuTargetMap
  readonly lifetime: AbortController
  resolve(target: MenuTarget, signal: AbortSignal): readonly MenuAction[] | Promise<readonly MenuAction[]>
}

/** React-free registry; each occurrence captures the providers registered at opening. */
export class MenuRegistry {
  private readonly providers = new Map<string, Provider>()
  private readonly occurrences = new Set<() => void>()
  private disposed = false
  constructor(private readonly failed: (message?: string) => void) {}

  /**
   * Register actions for subsequent openings.
   * @param input - provider definition.
   * @returns removal of this contribution and its pending resolutions.
   */
  register<K extends keyof MenuTargetMap>(input: MenuContribution<K>): () => void {
    if (this.disposed) throw new Error('Menu registry is disposed')
    const key = `${encodeURIComponent(input.target)}/${encodeURIComponent(input.id)}`
    if (this.providers.has(key)) throw new Error(`Duplicate menu contribution: ${key}`)
    const provider: Provider = {
      id: input.id, kind: input.target, order: input.order, lifetime: new AbortController(),
      resolve: (target, signal) => input.resolve(target.value as MenuTargetMap[K], signal),
    }
    this.providers.set(key, provider)
    return () => {
      if (provider.lifetime.signal.aborted) return
      this.providers.delete(key)
      provider.lifetime.abort()
    }
  }

  /**
   * Resolve an independently owned occurrence.
   * @param target - captured clicked identity.
   * @returns presentation, selection, and disposal.
   */
  resolve(target: MenuTarget): MenuResolution {
    if (this.disposed) throw new Error('Menu registry is disposed')
    const lifetime = new AbortController()
    const source = createSnapshotStore<readonly MenuActionView[]>([])
    const resolved = new Map<Provider, readonly MenuActionView[]>()
    const callbacks = new Map<string, { provider: Provider; action: MenuAction }>()
    const providers = [...this.providers.values()].filter(p => p.kind === target.kind)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    const refresh = (): void => {
      source.set(providers.flatMap(provider =>
        provider.lifetime.signal.aborted ? [] : resolved.get(provider) ?? []))
    }
    const cleanup: (() => void)[] = []
    const dispose = (): void => {
      if (lifetime.signal.aborted) return
      lifetime.abort()
      for (const detach of cleanup) detach()
      callbacks.clear()
      this.occurrences.delete(dispose)
    }
    this.occurrences.add(dispose)
    const pending: Promise<void>[] = []
    for (const provider of providers) {
      const signal = AbortSignal.any([lifetime.signal, provider.lifetime.signal])
      const accept = (actions: readonly MenuAction[]): void => {
        if (signal.aborted) return
        const next = new Map<string, MenuAction>()
        const project = (action: MenuAction, parent: string): MenuActionView => {
          const id = `${parent}/${encodeURIComponent(action.id)}`
          if (next.has(id)) throw new Error(`Duplicate menu action: ${id}`)
          next.set(id, action)
          const { run: _run, failureLabel: _failureLabel, children, ...view } = action
          return { ...view, id, ...(children === undefined ? {} : { children: children.map(child => project(child, id)) }) }
        }
        const views = actions.map(action => project(action, encodeURIComponent(provider.id)))
        for (const [id, action] of next) callbacks.set(id, { provider, action })
        resolved.set(provider, views)
        refresh()
      }
      provider.lifetime.signal.addEventListener('abort', refresh, { once: true })
      cleanup.push(() => { provider.lifetime.signal.removeEventListener('abort', refresh) })
      try {
        const result = provider.resolve(target, signal)
        if (result instanceof Promise) {
          pending.push(new Promise<void>((settle) => {
            const finish = (): void => { signal.removeEventListener('abort', finish); settle() }
            signal.addEventListener('abort', finish, { once: true })
            void result.then(accept).catch(() => { if (!signal.aborted) this.failed() }).finally(finish)
          }))
        } else accept(result)
      } catch (_error) { if (!signal.aborted) this.failed() }
    }
    return {
      source, dispose, ready: Promise.all(pending).then(() => {}),
      select: (id) => {
        const selected = callbacks.get(id)
        if (lifetime.signal.aborted || selected === undefined || selected.provider.lifetime.signal.aborted
          || selected.action.disabled || selected.action.children !== undefined) return
        const run = selected.action.run
        dispose()
        try { void Promise.resolve(run?.()).catch(() => { this.failed(selected.action.failureLabel) }) }
        catch (_error) { this.failed(selected.action.failureLabel) }
      },
    }
  }

  /** Cancel every occurrence and reject further registrations or resolutions. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const dispose of this.occurrences) dispose()
    for (const provider of this.providers.values()) provider.lifetime.abort()
    this.providers.clear()
  }
}
