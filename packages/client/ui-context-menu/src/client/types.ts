/** Client menu contributions and explicit gesture targets. */
import type { MenuItem } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PaneId, TabRecord } from '@deepseek-ai/dsh-client-ui-dockkit'

/** External plugins extend this map with their own target families. */
export interface MenuTargetMap {
  session: { readonly sessionId: SessionId; readonly displayTitle: string }
  file: { readonly sessionId: SessionId; readonly path: string; readonly line?: number; readonly paneId?: PaneId }
  directory: { readonly sessionId: SessionId; readonly path: string }
  url: { readonly sessionId: SessionId; readonly url: string }
  image: {
    readonly sessionId?: SessionId
    readonly url: string
    readonly name?: string
    readonly mediaType?: string
    readonly path?: string
  }
  tab: { readonly sessionId: SessionId; readonly paneId: PaneId; readonly tab: TabRecord }
}

/** Captured target; changing selection never changes an open menu's target. */
export type MenuTarget = { [K in keyof MenuTargetMap]: { readonly kind: K; readonly value: MenuTargetMap[K] } }[keyof MenuTargetMap]
/** Pointer position in CSS pixels; keyboard gestures use the trigger's bottom edge. */
export interface MenuPoint { readonly x: number; readonly y: number }
/** Client presentation fields; callbacks stay in the registry. */
export interface MenuActionView {
  readonly id: string
  readonly label: string
  /** Command identity for live shortcut display only; selection still invokes this action’s run callback. */
  readonly commandId?: ShortcutCommandId
  readonly disabled?: boolean
  readonly icon?: MenuItem['icon']
  readonly danger?: boolean
  readonly separatorBefore?: boolean
  /** Render after legacy component contributions in the shared Web popup. */
  readonly afterContent?: boolean
  readonly children?: readonly MenuActionView[]
}
/** A contribution can decline, return actions immediately, or resolve metadata asynchronously. */
export interface MenuAction extends Omit<MenuActionView, 'children'> {
  readonly children?: readonly MenuAction[]
  /** Localized operation and recovery guidance when execution rejects. */
  readonly failureLabel?: string
  /** Execute against the captured target. Reject for a visible failure; cancellation resolves normally. */
  readonly run?: () => void | Promise<void>
}
/** A namespaced contribution, ordered within its target family. */
export interface MenuContribution<K extends keyof MenuTargetMap> {
  readonly id: string
  readonly target: K
  readonly order: number
  /**
   * Reactive inputs that re-resolve actions for the same captured target.
   * @param target - clicked object.
   * @returns sources owned by the contributing feature; unsubscribed on dismissal or unload.
   */
  observe?(target: MenuTargetMap[K]): readonly ObservableSnapshot<unknown>[]
  /**
   * @param target - clicked object.
   * @param signal - aborted on dismissal, plugin unload, or a newer observed preparation.
   * @returns available actions.
   */
  resolve(target: MenuTargetMap[K], signal: AbortSignal): readonly MenuAction[] | Promise<readonly MenuAction[]>
}
/** Independent menu occurrence used by custom renderers and embedded menus. */
export interface MenuResolution {
  /** Read a new immutable presentation after each provider settles, updates, or is withdrawn. */
  readonly source: import('@deepseek-ai/dsh-client-store').ObservableSnapshot<readonly MenuActionView[]>
  /** Settles when all opening contributions have completed or been withdrawn. */
  readonly ready: Promise<void>
  /**
   * Select once; disposed or removed contributions cannot execute.
   * @param id - resolved action id.
   */
  select(id: string): void
  /** Cancel metadata queries and discard callbacks. */
  dispose(): void
}
/** Client capability used equally by built-in and external plugins. */
export interface ContextMenus {
  /** Captured target of the shared popup; null after dismissal. */
  readonly active: import('@deepseek-ai/dsh-client-store').ObservableSnapshot<MenuTarget | null>
  /**
   * Register for subsequent openings; unloading withdraws actions and aborts their queries. Duplicate ids within a target fail.
   * @param contribution - target provider.
   * @returns unregister.
   */
  register<K extends keyof MenuTargetMap>(contribution: MenuContribution<K>): () => void
  /**
   * Open the single shared popup.
   * @param target - captured object.
   * @param point - viewport position.
   */
  open(target: MenuTarget, point: MenuPoint): void
  /**
   * Resolve an embedded menu without opening the shared popup.
   * @param target - captured object.
   * @returns owned occurrence.
   */
  resolve(target: MenuTarget): MenuResolution
  /** Close the shared popup and cancel its metadata queries. */
  close(): void
  /**
   * Show localized feedback outside the originating surface.
   * @param text - localized message.
   * @param success - successful action.
   */
  notify(text: string, success?: boolean): void
}
