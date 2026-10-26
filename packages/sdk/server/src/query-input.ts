/** Desktop text-input recognition for the SDK; command execution stays with the native registry. */

import type { CommandDescriptor } from '@deepseek-ai/dsh-commands/types'

/**
 * Recognize compact, explicit permission changes, plan, and goal using fixed names or Chinese aliases.
 * Aliases require the official definitionId and canonical registered name; custom renaming is unsupported.
 * Other text remains a prompt.
 * @param text - original input; the caller preserves it on the ordinary-prompt path.
 * @param commands - exact receiving Agent's current command descriptors.
 * @returns the supported command line using its canonical name and a native-compatible separator, otherwise undefined.
 */
export function queryCommand(text: string, commands: readonly CommandDescriptor[]): string | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return undefined
  const separator = trimmed.search(/\s/u)
  const name = separator === -1 ? trimmed.slice(1) : trimmed.slice(1, separator)
  const alias = name === '压缩' ? '@deepseek-ai/dsh-command-compact'
    : name === '权限' ? '@deepseek-ai/dsh-permission-presets'
      : name === '计划' ? '@deepseek-ai/dsh-plan-mode'
        : name === '目标' ? '@deepseek-ai/dsh-command-goal' : undefined
  const descriptor = commands.find(command => command.name === name)
    ?? (alias === undefined ? undefined : commands.find(command => command.definitionId === alias))
  const rawInput = separator === -1 ? '' : trimmed.slice(separator).replace(/^[^\S \t\r\n]/u, ' ')
  if (descriptor?.name === 'compact' && separator === -1) return '/compact'
  if (descriptor?.name === 'permission' && separator !== -1) return `/permission${rawInput}`
  if (descriptor?.name === 'plan') return `/plan${rawInput}`
  if (descriptor?.name === 'goal') return `/goal${rawInput}`
  return undefined
}
