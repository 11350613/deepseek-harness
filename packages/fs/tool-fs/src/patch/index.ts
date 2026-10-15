/** Internal patch executor; tool registration and persisted result metadata are owned by its caller. */
import type { Context } from '@deepseek-ai/cordis'
import { PatchParseError } from '@deepseek-ai/dsh-fs-patch'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { FsSandboxController } from '../sandbox.ts'
import { commitPatch } from './execute.ts'
import { planPatch } from './plan.ts'
import { preflightPatch } from './preflight.ts'
import type { PatchExecutionReport, PatchExecutionRequest } from './types.ts'

export type { PatchExecutionReport, PatchExecutionRequest, PatchFailure, PatchFailureCode, PatchFileChange, PatchOperationOutcome, PatchOperationRecord } from './types.ts'

/**
 * Preflight a whole patch before sequential guarded mutations; business failures become records.
 * @param ctx - mounted filesystem and observation-policy events.
 * @param sandbox - denial mapper shared with existing filesystem tools.
 * @param exec - session cwd, observation actor, and cancellation signal.
 * @param request - raw patch and policy already resolved by the caller.
 * @returns ordered results retaining completed, partial, unknown, and skipped effects.
 * @throws unexpected programming defects without starting further operations.
 */
export async function executePatch(
  ctx: Context, sandbox: FsSandboxController, exec: ToolExecution, request: PatchExecutionRequest,
): Promise<PatchExecutionReport> {
  let plan
  try { plan = await planPatch(ctx, sandbox, exec, request) } catch (error) {
    if (!(error instanceof PatchParseError)) throw error
    return { phase: 'syntax', failure: { code: 'PATCH_SYNTAX', message: error.message }, outcomes: [], affectedPaths: [], cancelled: false }
  }
  const outcomes = [
    ...plan.failures,
    ...await preflightPatch(ctx, sandbox, exec, request.sandboxPolicy, plan.operations),
  ].sort((left, right) => left.operation.index - right.operation.index)
  if (outcomes.some(outcome => outcome.status === 'failed')) {
    return { phase: 'preflight', outcomes, affectedPaths: [], cancelled: exec.signal.aborted }
  }
  return commitPatch(ctx, sandbox, exec, request.sandboxPolicy, plan.operations)
}
