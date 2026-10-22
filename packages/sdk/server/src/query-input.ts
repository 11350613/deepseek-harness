/** Desktop text-input recognition for the SDK; command execution stays with the native registry. */

import type { CommandDescriptor } from '@deepseek-ai/dsh-commands/types'

/**
 * Recognize the supported bare compact form; all other input retains ordinary prompt behavior.
 * @param text - original input; the caller preserves it on the ordinary-prompt path.
 * @param commands - exact receiving Agent's current command descriptors.
 * @returns `/compact` for its effective name or Desktop alias, otherwise undefined.
 */
export function queryCommand(text: string, commands: readonly CommandDescriptor[]): string | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/') || /\s/u.test(trimmed)) return undefined
  const name = trimmed.slice(1)
  const descriptor = commands.find(command => command.name === name)
    ?? (name === '压缩' ? commands.find(command => command.definitionId === '@deepseek-ai/dsh-command-compact') : undefined)
  return descriptor?.name === 'compact' ? '/compact' : undefined
}
