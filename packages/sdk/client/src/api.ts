/**
 * High-level input and run APIs over {@link HarnessClient}. Sessions can send
 * input independently of receiving its notifications and result, or collect
 * a prompt's receipt-to-idle activity through `run()`.
 *
 * @module @deepseek-ai/dsh-sdk-client/api
 */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { SessionQueryResult } from '@deepseek-ai/dsh-sdk-protocol'
import { createProcessHarnessClient, HarnessClient, isRecord, SdkProtocolError } from './client.ts'
import type { NotificationSubscription } from './client.ts'
import type { RuntimeProcessOptions } from './launch.ts'
import type { ContentBlock, DeepSeekHarnessOptions, HarnessNotification, QueryMessage, RunResult, SdkPromptContentBlock } from './types.ts'

/**
 * Reusable SDK for running DeepSeek Harness agent turns in a runtime
 * subprocess. The subprocess starts lazily on first use and stays owned by
 * this instance until {@link close}; always close (or `await using`) so the
 * child is reaped.
 */
export class DeepSeekHarness implements AsyncDisposable {
  private clientInstance: HarnessClient
  private readonly createClient: () => HarnessClient
  private readonly cwd: string
  private readonly provider: string
  private readonly model: string
  private readonly reasoningEffort: DeepSeekHarnessOptions['reasoningEffort']
  private readonly maxTokens: number | undefined
  private readonly approvalRequests: boolean | undefined
  private initialized: Promise<void> | undefined
  private closed = false

  /** @param options - dsh launch configuration plus the session route, effort, and output cap. */
  constructor(options?: DeepSeekHarnessOptions)
  constructor(options: DeepSeekHarnessOptions = {}, clientFactory?: () => HarnessClient) {
    this.createClient = clientFactory ?? (() => new HarnessClient(options))
    this.clientInstance = this.createClient()
    // Absolute before the handshake: the child spawns relative to THIS
    // process's cwd, but the wire cwd is resolved again inside the child — a
    // relative value would double-resolve (e.g. `worker` → `worker/worker`).
    this.cwd = resolve(options.cwd ?? options.processCwd ?? process.cwd())
    this.provider = options.provider ?? 'deepseek-official'
    this.model = options.model ?? 'deepseek-v4-flash'
    this.reasoningEffort = options.reasoningEffort
    this.maxTokens = options.maxTokens
    this.approvalRequests = options.approvalRequests
  }

  /**
   * The underlying JSON-RPC client (exposed for low-level access). A failed
   * handshake swaps in a fresh instance only after cleanup proves the runtime
   * exited; cleanup failure retains this client, so do not cache it across a
   * failed {@link start}.
   * @returns the client currently owning the runtime subprocess.
   */
  get client(): HarnessClient {
    return this.clientInstance
  }

  /**
   * Start the subprocess and perform the `initialize` handshake once. On
   * failure, successful SDK-owned cleanup reaps the runtime and installs a
   * fresh client (`HarnessClient.close` is permanent), so a later call retries
   * with a new subprocess unless {@link close} already ended this harness. If
   * cleanup also fails, rejects with an `AggregateError` whose ordered errors
   * preserve both causes and retains the failed client rather than spawning
   * alongside a process whose exit was not proved.
   * @returns settlement of the (memoized) handshake.
   */
  start(): Promise<void> {
    this.initialized ??= (async () => {
      try {
        this.clientInstance.start()
        await this.clientInstance.initialize({
          cwd: this.cwd,
          provider: this.provider,
          model: this.model,
          ...this.reasoningEffort === undefined ? {} : { reasoningEffort: this.reasoningEffort },
          ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
          ...this.approvalRequests === undefined ? {} : { approvalRequests: this.approvalRequests },
        })
      } catch (error) {
        this.initialized = undefined
        try {
          await this.clientInstance.close()
        } catch (cleanupError: unknown) {
          throw new AggregateError(
            [error, cleanupError],
            'DeepSeek Harness initialization and cleanup failed',
          )
        }
        if (!this.closed) this.clientInstance = this.createClient()
        throw error
      }
    })()
    return this.initialized
  }

  /**
   * Open a session handle (no wire traffic; the runtime creates the session
   * on its first prompt or working-directory operation).
   * @param sessionId - explicit id to reuse; omitted mints a fresh one.
   * @returns the session handle.
   */
  session(sessionId?: string): HarnessSession {
    return new HarnessSession(this, sessionId ?? `session-${randomUUID().replaceAll('-', '')}`)
  }

  /**
   * Start the runtime and restore a persisted session without sending input.
   * The configured Harness home must contain its history; missing or occupied sessions reject.
   * @param sessionId - exact persisted identity to continue.
   * @returns a handle ready to run new prompts on the restored history.
   */
  async resumeSession(sessionId: string): Promise<HarnessSession> {
    await this.start()
    await this.client.resumeSession(sessionId)
    return new HarnessSession(this, sessionId)
  }

  /**
   * Run one prompt on a fresh (or named) session.
   * @param input - prompt text, or content blocks sent verbatim.
   * @param options - optional session id and per-notification observer.
   * @returns the owned activity interval.
   */
  run(input: string | SdkPromptContentBlock[], options?: RunOptions): Promise<RunResult> {
    return this.session(options?.sessionId).run(input, options)
  }

  /**
   * Shut down and reap the runtime subprocess. Idempotent and terminal —
   * a closed harness no longer retries a failed handshake.
   * @returns settlement of the complete teardown.
   */
  close(): Promise<void> {
    this.closed = true
    return this.clientInstance.close()
  }

  /**
   * `await using` support: {@link close}.
   * @returns settlement of the teardown.
   */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}

/** Construct the high-level API against a generic process for package-local fake-runtime tests. */
export function createProcessDeepSeekHarness(
  runtime: RuntimeProcessOptions,
  options: DeepSeekHarnessOptions = {},
): DeepSeekHarness {
  const Constructor = DeepSeekHarness as new (
    publicOptions: DeepSeekHarnessOptions,
    clientFactory: () => HarnessClient,
  ) => DeepSeekHarness
  return new Constructor({
    ...runtime.cwd === undefined ? {} : { processCwd: runtime.cwd },
    ...options,
  }, () => createProcessHarnessClient(runtime))
}

/** Per-run options: target session and streaming observer. */
export interface RunOptions {
  /** Session id to run on; omitted mints a fresh session per call. */
  sessionId?: string
  /** Observer invoked with every notification for this session tree, in wire order. */
  onNotification?: (notification: HarnessNotification) => void
}

/** Ordinary prompt delivery for one unified input; command admission remains runtime-owned. */
export interface QueryOptions {
  /** Queue a new turn by default, or steer the next available step. */
  delivery?: 'queue' | 'steer'
}

type QueryOutcome =
  | { readonly kind: 'result'; readonly result: SessionQueryResult }
  | { readonly kind: 'error'; readonly error: unknown }

interface PendingQuery {
  readonly outcome: Promise<QueryOutcome>
  readonly subscription: NotificationSubscription
  readonly abandon: AbortController
  readonly commandNotifications: HarnessNotification[]
}

/**
 * One SDK session: a stable id plus owned activity intervals.
 */
export class HarnessSession {
  private readonly pendingQueries: PendingQuery[] = []

  /**
   * @param harness - the owning harness (supplies the client and handshake).
   * @param id - the wire session id this handle runs on.
   */
  constructor(readonly harness: DeepSeekHarness, readonly id: string) {}

  /**
   * Send text for runtime prompt-or-command routing without waiting for its result.
   * @param text - complete input text; the runtime interprets slash input.
   * @param options - ordinary prompt delivery, defaulting to a new queued turn.
   * @returns after initialization and sending; routing failures surface from `receiveResponse()`.
   */
  async query(text: string, options: QueryOptions = {}): Promise<void> {
    await this.harness.start()
    const client = this.harness.client
    const subscription = client.subscribeSessionTree(this.id)
    const abandon = new AbortController()
    const commandNotifications: HarnessNotification[] = []
    const outcome = client.query(this.id, text, options.delivery ?? 'queue', abandon.signal).then<QueryOutcome>(
      (result) => {
        if (result.kind === 'command') {
          for (let notification = subscription.tryNext(); notification !== undefined; notification = subscription.tryNext()) {
            commandNotifications.push(notification)
            const event = notification.params.event
            if (notification.method === 'session.event' && notification.params.sessionId === this.id
              && isRecord(event) && event.type === 'command/done' && isRecord(event.data)
              && event.data.commandId === result.execution.commandId) break
          }
          subscription.close()
        }
        return { kind: 'result', result }
      },
    ).catch((error: unknown): QueryOutcome => {
      subscription.close()
      return { kind: 'error', error }
    })
    this.pendingQueries.push({ outcome, subscription, abandon, commandNotifications })
  }

  /**
   * Observe the oldest query not yet assigned to a receiver.
   * @returns an iterator of notifications followed by `RunResult` or `CommandExecution`.
   * Its resources close before the final result is yielded. Returning early abandons
   * only local observation, including before the first `next()`; runtime work continues.
   * @throws when no query awaits reception, or when its request, protocol, or transport fails.
   */
  receiveResponse(): AsyncIterableIterator<QueryMessage> {
    const pending = this.pendingQueries.shift()
    if (pending === undefined) throw new Error('No query is waiting for a response')
    const isClosed = (): boolean => pending.abandon.signal.aborted
    const close = (): void => {
      if (isClosed()) return
      pending.abandon.abort(new Error('Query observation closed; runtime work was not cancelled'))
      pending.subscription.close()
      pending.commandNotifications.length = 0
    }
    const sessionId = this.id
    const iterator = (async function* (): AsyncGenerator<QueryMessage, void, unknown> {
      try {
        const outcome = await pending.outcome
        if (isClosed()) return
        if (outcome.kind === 'error') throw outcome.error
        if (outcome.result.kind === 'command') {
          for (const notification of pending.commandNotifications) yield notification
          close()
          yield outcome.result.execution
          return
        }
        const events: SessionEvent[] = []
        const notifications: HarnessNotification[] = []
        let received = false
        while (!isClosed()) {
          const notification = await pending.subscription.next()
          if (!received) {
            if (notification.method !== 'session.event' || notification.params.sessionId !== sessionId
              || !isInboxReceipt(notification.params.event, outcome.result.messageId)) continue
            received = true
          }
          if (notification.method === 'session.event' && notification.params.sessionId === sessionId) {
            events.push(validatedSessionEvent(notification.params.event))
          }
          notifications.push(notification)
          yield notification
          if (notification.method === 'session.status' && notification.params.sessionId === sessionId
            && notification.params.status === 'idle') break
        }
        if (isClosed()) return
        close()
        yield { sessionId, finalResponse: finalResponse(events), events, notifications }
      } catch (error: unknown) {
        if (!isClosed()) throw error
      } finally {
        close()
      }
    })()
    return {
      [Symbol.asyncIterator]() { return this },
      next: () => iterator.next(),
      return: () => {
        close()
        return iterator.return(undefined)
      },
    }
  }

  /**
   * Read the effective directory and recover a missing directory to the Session origin.
   * @returns the absolute directory used by new independent operations.
   */
  async getWorkingDirectory(): Promise<string> {
    await this.harness.start()
    return this.harness.client.getWorkingDirectory(this.id)
  }

  /**
   * Change the effective directory without moving existing processes or changing permissions.
   * @param path - absolute or Session-current-directory-relative directory.
   * @returns the validated absolute directory.
   */
  async setWorkingDirectory(path: string): Promise<string> {
    await this.harness.start()
    return this.harness.client.setWorkingDirectory(this.id, path)
  }

  /**
   * Queue one prompt, then observe the whole session through its next idle.
   * @param input - prompt text, or content blocks sent verbatim.
   * @param options - optional per-notification observer.
   * @returns the owned activity interval; rejects on transport loss, timeout,
   * or a protocol error.
   */
  async run(input: string | SdkPromptContentBlock[], options?: Pick<RunOptions, 'onNotification'>): Promise<RunResult> {
    await this.harness.start()
    const client = this.harness.client
    const contentBlocks = normalizeInput(input)
    const events: SessionEvent[] = []
    const notifications: HarnessNotification[] = []

    const subscription = client.subscribeSessionTree(this.id)
    const collect = (notification: HarnessNotification): void => {
      if (notification.method === 'session.event' && notification.params.sessionId === this.id) {
        // Wire boundary: the envelope feeds the typed RunResult, so a
        // malformed runtime surfaces as a protocol error, not as type-invalid
        // data (or a TypeError out of finalResponse).
        const event = validatedSessionEvent(notification.params.event)
        notifications.push(notification)
        options?.onNotification?.(notification)
        events.push(event)
        return
      }
      notifications.push(notification)
      options?.onNotification?.(notification)
    }
    try {
      const messageId = await client.prompt(this.id, contentBlocks)
      let received = false
      while (true) {
        const notification = await subscription.next()
        if (!received) {
          if (notification.method !== 'session.event'
            || notification.params.sessionId !== this.id
            || !isInboxReceipt(notification.params.event, messageId)) continue
          received = true
        }
        collect(notification)
        if (notification.method === 'session.status'
          && notification.params.sessionId === this.id
          && notification.params.status === 'idle') break
      }
    } finally {
      subscription.close()
    }

    return {
      sessionId: this.id,
      finalResponse: finalResponse(events),
      events,
      notifications,
    }
  }
}

/**
 * Normalize run input: a string becomes one text block; blocks pass verbatim.
 * @param input - prompt text or content blocks.
 * @returns the content blocks to send.
 */
export function normalizeInput(input: string | SdkPromptContentBlock[]): SdkPromptContentBlock[] {
  return typeof input === 'string' ? [{ type: 'text', text: input }] : input
}

/** Validate the provider-read fields of one wire turn-end reason. */
function validatedTurnEndReason(value: unknown): TurnEndReason {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new SdkProtocolError(`turn/end carried no reason envelope: ${JSON.stringify(value)}`)
  }
  if (value.kind === 'aborted') {
    if (!isRecord(value.reason) || typeof value.reason.kind !== 'string') {
      throw new SdkProtocolError(`turn/end carried a malformed aborted reason: ${JSON.stringify(value)}`)
    }
    switch (value.reason.kind) {
      case 'user':
      case 'parent':
      case 'disposed':
      case 'legacy':
        break
      case 'hook':
        if (typeof value.reason.reason !== 'string') {
          throw new SdkProtocolError(`turn/end carried a malformed hook abort reason: ${JSON.stringify(value)}`)
        }
        break
      default:
        throw new SdkProtocolError(`turn/end carried an unknown abort reason: ${JSON.stringify(value)}`)
    }
  }
  return value as TurnEndReason
}

/**
 * Validate the event envelope and assistant/turn fields consumed by SDK readers.
 * @param value - the raw `session.event` event payload.
 * @returns the event, or throws a protocol error for malformed consumed fields.
 */
export function validatedSessionEvent(value: unknown): SessionEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new SdkProtocolError(`session.event carried no event envelope: ${JSON.stringify(value)}`)
  }
  // The one variant this module reads into (finalResponse) must carry
  // kind-tagged content blocks; other variants pass through under their
  // envelope shape.
  if (value.type === 'assistant/message') {
    const message = isRecord(value.data) ? value.data.message : undefined
    const content = isRecord(message) ? message.content : undefined
    if (!Array.isArray(content) || !content.every(block => isRecord(block) && typeof block.type === 'string')) {
      throw new SdkProtocolError(`assistant/message event carried malformed content: ${JSON.stringify(value)}`)
    }
  }
  if (value.type === 'turn/end') {
    const data = isRecord(value.data) ? value.data : undefined
    if (data === undefined) {
      throw new SdkProtocolError(`turn/end event carried malformed data: ${JSON.stringify(value)}`)
    }
    validatedTurnEndReason(data.reason)
  }
  return value as SessionEvent
}

/** Whether a raw session event is the durable enqueue receipt for `messageId`. */
function isInboxReceipt(value: unknown, messageId: string): boolean {
  if (!isRecord(value) || value.type !== 'agent/inbox/spliced' || !isRecord(value.data)) return false
  const inserted = value.data.inserted
  return Array.isArray(inserted) && inserted.some(message => isRecord(message) && message.id === messageId)
}

/**
 * Extract the concatenated text of the last assistant message.
 * @param events - the activity interval's `session.event` payloads in wire order.
 * @returns the final response text, or `''` when no assistant message exists.
 */
export function finalResponse(events: SessionEvent[]): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    return event.data.message.content
      .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
      .map(block => block.text)
      .join('')
  }
  return ''
}
