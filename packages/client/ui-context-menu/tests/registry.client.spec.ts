import { describe, expect, it, vi } from 'vitest'
import { MenuRegistry } from '../src/client/registry.ts'
import type { MenuAction } from '@deepseek-ai/dsh-client-ui-context-menu/client'

declare module '@deepseek-ai/dsh-client-ui-context-menu/client' {
  interface MenuTargetMap { extension: { readonly id: string } }
}
const target = { kind: 'extension' as const, value: { id: 'clicked' } }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('menu contribution lifecycle', () => {
  it('orders independently resolved contributions and executes the captured target once', async () => {
    const failure = vi.fn(), run = vi.fn()
    const registry = new MenuRegistry(failure)
    const waiting = deferred<readonly MenuAction[]>()
    registry.register({ id: 'later', target: 'extension', order: 20, resolve: () => waiting.promise })
    registry.register({ id: 'first', target: 'extension', order: 10, resolve: ({ id }) => [{ id: 'open', label: id, run: () => { run(id) } }] })
    const menu = registry.resolve(target)
    expect(menu.source.getSnapshot().map(x => x.id)).toEqual(['first/open'])
    waiting.resolve([{ id: 'open', label: 'Later' }]); await waiting.promise
    expect(menu.source.getSnapshot().map(x => x.id)).toEqual(['first/open', 'later/open'])
    expect(JSON.parse(JSON.stringify(menu.source.getSnapshot()))).toEqual(menu.source.getSnapshot())
    menu.select('first/open'); menu.select('first/open')
    expect(run).toHaveBeenCalledExactlyOnceWith('clicked')
    expect(failure).not.toHaveBeenCalled()
    registry.dispose()
  })

  it.each(['menu', 'provider', 'registry'] as const)('aborts pending metadata when its %s retires', async (retire) => {
    const failure = vi.fn(), run = vi.fn()
    const registry = new MenuRegistry(failure)
    const waiting = deferred<readonly MenuAction[]>()
    let signal!: AbortSignal
    const remove = registry.register({ id: 'slow', target: 'extension', order: 0, resolve: (_target, lifetime) => { signal = lifetime; return waiting.promise } })
    const menu = registry.resolve(target)
    if (retire === 'menu') menu.dispose()
    if (retire === 'provider') remove()
    if (retire === 'registry') registry.dispose()
    expect(signal.aborted).toBe(true)
    waiting.resolve([{ id: 'late', label: 'Late', run }]); await waiting.promise
    expect(menu.source.getSnapshot()).toEqual([])
    menu.select('slow/late')
    expect(run).not.toHaveBeenCalled()
    expect(failure).not.toHaveBeenCalled()
    menu.dispose(); remove(); registry.dispose()
  })

  it('withdraws resolved actions on unload and takes new contributions on the next opening', () => {
    const registry = new MenuRegistry(vi.fn()), run = vi.fn()
    const remove = registry.register({ id: 'old', target: 'extension', order: 0, resolve: () => [{ id: 'a', label: 'A', run }] })
    const first = registry.resolve(target)
    remove(); remove()
    expect(first.source.getSnapshot()).toEqual([])
    first.select('old/a'); expect(run).not.toHaveBeenCalled()
    registry.register({ id: 'new', target: 'extension', order: 0, resolve: () => [{ id: 'b', label: 'B' }] })
    expect(first.source.getSnapshot()).toEqual([])
    const next = registry.resolve(target)
    expect(next.source.getSnapshot()[0]?.id).toBe('new/b')
    first.dispose(); next.dispose(); registry.dispose()
    expect(() => registry.resolve(target)).toThrow('disposed')
  })

  it('contains provider failure and rejects duplicate contributions without corrupting other actions', async () => {
    const failed = vi.fn(), run = vi.fn(), registry = new MenuRegistry(failed)
    const definition = { id: 'good', target: 'extension' as const, order: 0, resolve: () => [{ id: 'a', label: 'A', run }] }
    registry.register(definition)
    expect(() => registry.register(definition)).toThrow('Duplicate menu contribution')
    registry.register({ id: 'bad', target: 'extension', order: 1, resolve: () => [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] })
    registry.register({ id: 'rejected', target: 'extension', order: 2, resolve: () => Promise.reject(new Error('unavailable')) })
    const menu = registry.resolve(target)
    await Promise.resolve(); await Promise.resolve()
    expect(failed).toHaveBeenCalledTimes(2)
    expect(menu.source.getSnapshot().map(x => x.id)).toEqual(['good/a'])
    menu.select('bad/a'); expect(run).not.toHaveBeenCalled()
    menu.select('good/a'); expect(run).toHaveBeenCalledOnce()
    registry.dispose()
  })

  it('ignores disabled, submenu and unknown selections and reports an action rejection', async () => {
    const failed = vi.fn(), run = vi.fn(), registry = new MenuRegistry(failed)
    registry.register({ id: 'actions', target: 'extension', order: 0, resolve: () => [
      { id: 'disabled', label: 'Disabled', disabled: true, run },
      { id: 'parent', label: 'Parent', children: [{ id: 'child', label: 'Child', run: () => Promise.reject(new Error('failed')) }], run },
    ] })
    const menu = registry.resolve(target)
    menu.select('missing'); menu.select('actions/disabled'); menu.select('actions/parent')
    expect(run).not.toHaveBeenCalled()
    menu.select('actions/parent/child'); await Promise.resolve(); await Promise.resolve()
    expect(failed).toHaveBeenCalledOnce()
    registry.dispose()
  })

  it('orders equal-priority providers by identity and contains synchronous action failures', () => {
    const failed = vi.fn(), registry = new MenuRegistry(failed)
    registry.register({ id: 'z', target: 'extension', order: 1, resolve: () => [{ id: 'none', label: 'No action' }] })
    registry.register({ id: 'a', target: 'extension', order: 1, resolve: () => [{ id: 'throw', label: 'Fail',
      failureLabel: 'Could not copy. Try again.', run: () => { throw new Error('clipboard denied') } }] })
    const first = registry.resolve(target)
    expect(first.source.getSnapshot().map(item => item.id)).toEqual(['a/throw', 'z/none'])
    first.select('a/throw')
    expect(failed).toHaveBeenCalledWith('Could not copy. Try again.')
    const second = registry.resolve(target)
    second.select('z/none')
    registry.dispose()
    expect(() => registry.register({ id: 'late', target: 'extension', order: 0, resolve: () => [] })).toThrow('disposed')
  })

  it('does not report cancelled metadata failures, including unload during resolution', async () => {
    const failed = vi.fn(), registry = new MenuRegistry(failed)
    let remove = () => {}
    remove = registry.register({ id: 'self-removing', target: 'extension', order: 0, resolve: () => {
      remove(); throw new Error('owner unloaded')
    } })
    const waiting = deferred<readonly MenuAction[]>()
    registry.register({ id: 'late-rejection', target: 'extension', order: 1, resolve: () => waiting.promise })
    const menu = registry.resolve(target)
    menu.dispose()
    waiting.reject(new Error('cancelled'))
    await Promise.resolve(); await Promise.resolve()
    expect(failed).not.toHaveBeenCalled()
    registry.dispose()
  })
})

it('omits a provider that misses its deadline and ignores its late result', async () => {
  vi.useFakeTimers()
  const failed = vi.fn(), registry = new MenuRegistry(failed, 50)
  const waiting = deferred<readonly MenuAction[]>()
  let signal!: AbortSignal
  registry.register({ id: 'slow', target: 'extension', order: 0, resolve: (_target, value) => { signal = value; return waiting.promise } })
  registry.register({ id: 'ready', target: 'extension', order: 1, resolve: () => [{ id: 'copy', label: 'Copy' }] })
  const menu = registry.resolve(target)
  try {
    await vi.advanceTimersByTimeAsync(50)
    await menu.ready
    expect(signal.aborted).toBe(true)
    expect(menu.source.getSnapshot().map(item => item.label)).toEqual(['Copy'])
    expect(failed).toHaveBeenCalledOnce()
    waiting.resolve([{ id: 'late', label: 'Late' }])
    await waiting.promise
    expect(menu.source.getSnapshot().map(item => item.label)).toEqual(['Copy'])
  } finally { registry.dispose(); vi.useRealTimers() }
})
