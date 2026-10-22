/** Original-file actions independent of menu or image component ownership. */
import type { Context } from '@deepseek-ai/cordis'
import type { DesktopFileActions, FileActions } from '../types.ts'
import { BrowserFileActions } from './files.ts'

export type { FileActions, FileActionSource, FileSaveResult, SavedFileId } from '../types.ts'
declare module '@deepseek-ai/cordis' {
  interface Context { /** Original-file saving and image clipboard commands. */ fileActions: FileActions }
}
/** The native adapter is optional; Web uses its own download and save capabilities. */
export const inject = []
/** @param ctx - plugin-owned Client context. */
export function apply(ctx: Context): void {
  const desktop = (window as Window & { dshDesktop?: { fileActions?: DesktopFileActions } }).dshDesktop?.fileActions
  const actions = new BrowserFileActions(desktop)
  ctx.provide('fileActions', actions)
  ctx.effect(() => () => { actions.dispose() }, 'file actions: lifetime')
}
