/** Desktop text-input recognition for the SDK; command execution stays with the native registry. */

import type { CommandDescriptor } from '@deepseek-ai/dsh-commands/types'

/**
 * Recognize bare compact and permission with an explicit preset; other input remains a prompt.
 * @param text - original input; the caller preserves it on the ordinary-prompt path.
 * @param commands - exact receiving Agent's current command descriptors.
 * @returns the supported command line using its effective name, otherwise undefined.
 */
export function queryCommand(text: string, commands: readonly CommandDescriptor[]): string | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return undefined
  const separator = trimmed.search(/\s/u)
  const name = separator === -1 ? trimmed.slice(1) : trimmed.slice(1, separator)
  const alias = name === '压缩' ? '@deepseek-ai/dsh-command-compact'
    : name === '权限' ? '@deepseek-ai/dsh-permission-presets' : undefined
  const descriptor = commands.find(command => command.name === name)
    ?? (alias === undefined ? undefined : commands.find(command => command.definitionId === alias))
  if (descriptor?.name === 'compact' && separator === -1) return '/compact'
  if (descriptor?.name === 'permission' && separator !== -1) return `/permission${trimmed.slice(separator)}`
  return undefined
}
