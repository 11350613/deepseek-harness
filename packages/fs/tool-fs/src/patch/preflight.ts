/** Read-only simulation of patch effects; no internal read establishes model observation. */
import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget, FsTargetKey } from '@deepseek-ai/dsh-fs'
import { applyHunks } from '@deepseek-ai/dsh-fs-patch'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { FsSandboxController } from '../sandbox.ts'
import { sessionResolveOptions } from '../session-cwd.ts'
import { destinationIntent, mutationTargets, patchFailure, sourceIntent } from './plan.ts'
import type { PatchFailure, PatchOperationOutcome, PlannedOperation } from './types.ts'

interface SimulatedFile {
  exists: boolean
  info: FsInfo | undefined
  content?: string
  touched: boolean
}

class Preflight {
  failurePath = ''
  private readonly states = new Map<FsTargetKey, SimulatedFile>()

  constructor(
    private readonly ctx: Context, private readonly exec: ToolExecution, private readonly policy: SandboxExecutionPolicy | undefined,
  ) {}

  private async state(target: FsTarget): Promise<SimulatedFile> {
    const known = this.states.get(target.targetKey)
    if (known) return known
    const info = await this.ctx.fs.stat(target, this.exec.signal)
    const state = { exists: info !== undefined, info, touched: false }
    this.states.set(target.targetKey, state)
    return state
  }

  private async fence(operation: PlannedOperation): Promise<void> {
    if (this.policy === undefined || this.policy.mode === 'danger-full-access') return
    if (this.policy.mode === 'read-only') throw new FsError('filesystem mutations are denied', 'FS_SANDBOX_DENIED')
    const roots = await Promise.all(writableRoots(this.policy).map(root => this.ctx.fs.resolve(root)))
    for (const target of mutationTargets(operation)) {
      if (!roots.some(root => this.ctx.fs.contains(root, target))) {
        throw new FsError(`cannot modify "${target.displayPath}": outside writable roots`, 'FS_SANDBOX_DENIED')
      }
    }
  }

  private regular(state: SimulatedFile, target: FsTarget): void {
    if (state.info !== undefined && state.info.type !== 'file') {
      throw new FsError(`cannot modify "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
  }

  private async source(state: SimulatedFile, target: FsTarget, kind: 'delete' | 'edit'): Promise<void> {
    const intent = state.touched ? undefined : await sourceIntent(this.ctx, this.exec, target, kind)
    if (!state.exists) throw new FsError(`cannot ${kind} "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    this.regular(state, target)
    if (intent !== undefined && intent.version !== state.info?.version) {
      throw new FsError(`cannot ${kind} "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
  }

  private async destination(state: SimulatedFile, target: FsTarget): Promise<void> {
    const intent = state.touched ? undefined : await destinationIntent(this.ctx, this.exec, target)
    this.regular(state, target)
    if (intent?.kind === 'createIfAbsent' && state.exists) {
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
    }
    if (intent?.kind === 'replaceIfVersion' && (!state.exists || state.info?.version !== intent.version)) {
      throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
  }

  private async content(state: SimulatedFile, target: FsTarget): Promise<string> {
    if (state.content === undefined) state.content = (await this.ctx.fs.readText(target, this.exec.signal)).replace(/\r\n/g, '\n')
    return state.content
  }

  private publish(target: FsTarget, content?: string): void {
    this.states.set(target.targetKey, { exists: content !== undefined, info: undefined, touched: true,
      ...(content === undefined ? {} : { content }) })
  }

  async check(operation: PlannedOperation): Promise<PatchFailure | undefined> {
    this.failurePath = operation.target.displayPath
    await this.fence(operation)
    if (operation.kind === 'move' && operation.target.targetKey === operation.destination.targetKey) {
      throw new FsError(`cannot move "${operation.target.displayPath}" to itself`, 'FS_SAME_TARGET')
    }
    if (operation.kind === 'delete' || operation.kind === 'move') {
      const info = await this.ctx.fs.lstat(operation.rawPath, sessionResolveOptions(this.exec, this.policy?.workspaceRoot))
      if (info?.type === 'symlink') return { code: 'PATCH_SYMLINK_SOURCE',
        message: `cannot ${operation.kind} "${operation.target.displayPath}": path is a symbolic link — operate on its target path instead` }
    }
    const state = await this.state(operation.target)
    switch (operation.kind) {
      case 'add':
        await this.destination(state, operation.target)
        this.publish(operation.target, operation.content)
        return
      case 'delete':
        await this.source(state, operation.target, 'delete')
        this.publish(operation.target)
        return
      case 'update':
      case 'move': {
        await this.source(state, operation.target, 'edit')
        if (operation.kind === 'move') {
          this.failurePath = operation.destination.displayPath
          await this.destination(await this.state(operation.destination), operation.destination)
          this.failurePath = operation.target.displayPath
        }
        const result = applyHunks(await this.content(state, operation.target), operation.hunks)
        if (!result.ok) {
          const first = result.failure.pattern.slice(0, 1).join('')
          const characters = Array.from(first)
          const preview = characters.length > 80 ? `${characters.slice(0, 80).join('')}…` : first
          return { code: 'FS_PATCH_MISMATCH', hunkLine: result.failure.hunkLineNumber,
            message: `cannot patch "${operation.target.displayPath}": hunk at patch line ${result.failure.hunkLineNumber} (${result.failure.stage}) does not match — ${preview}` }
        }
        if (operation.kind === 'move') {
          this.publish(operation.destination, result.after)
          this.publish(operation.target)
        } else this.publish(operation.target, result.after)
        return
      }
      /* v8 ignore next -- Closed parsed-operation union; assertNever checks exhaustiveness at compile time. */
      default: return assertNever(operation)
    }
  }
}

/**
 * Collect all independent preflight failures while simulating only successful operations.
 * @param ctx - filesystem service owner; reads never emit observations.
 * @param sandbox - model-facing denial mapper.
 * @param exec - observation actor and cancellation signal.
 * @param policy - resolved confinement policy.
 * @param operations - complete resolved operation plan.
 * @returns failed/skipped entries; any failure forbids the entire commit phase.
 */
export async function preflightPatch(
  ctx: Context, sandbox: FsSandboxController, exec: ToolExecution, policy: SandboxExecutionPolicy | undefined,
  operations: readonly PlannedOperation[],
): Promise<PatchOperationOutcome[]> {
  const preflight = new Preflight(ctx, exec, policy)
  const outcomes: PatchOperationOutcome[] = []
  for (const operation of operations) {
    let failure: PatchFailure | undefined
    try { failure = await preflight.check(operation) } catch (error) {
      if (!(error instanceof FsError)) throw error
      failure = patchFailure(sandbox, policy, error, preflight.failurePath)
    }
    outcomes.push(failure === undefined ? { status: 'skipped', operation: operation.record }
      : { status: 'failed', operation: operation.record, failure, changes: [] })
  }
  return outcomes
}
