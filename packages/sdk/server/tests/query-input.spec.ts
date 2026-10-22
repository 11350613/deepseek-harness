import { describe, expect, it } from 'vitest'
import { CommandDefinitionId, type CommandDescriptor } from '@deepseek-ai/dsh-commands'
import { queryCommand } from '../src/query-input.ts'

const commands: readonly CommandDescriptor[] = [
  { name: 'compact', definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-compact'), description: 'Compact' },
  { name: 'plan', definitionId: CommandDefinitionId('@deepseek-ai/dsh-plan-mode'), description: 'Plan', input: { hint: 'Task' } },
  { name: 'goal', definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-goal'), description: 'Goal', input: { hint: 'Goal' } },
  { name: 'permission', definitionId: CommandDefinitionId('@deepseek-ai/dsh-permission-presets'), description: 'Permission', input: { hint: 'Preset' } },
  { name: 'feedback', definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-feedback'), description: 'Feedback', input: { hint: 'Feedback' } },
  { name: 'export', definitionId: CommandDefinitionId('@deepseek-ai/dsh-session-log-export'), description: 'Export' },
]

describe('SDK query text recognition', () => {
  it.each([
    ['/compact', '/compact'], [' \n/compact \t', '/compact'], ['/压缩', '/compact'],
  ])('recognizes the Desktop form %j', (text, expected) => {
    expect(queryCommand(text, commands)).toBe(expected)
  })

  it.each(['ordinary text', '/', '/unknown', '/usr/bin', '/COMPACT', '/模型', '/文件',
    '/compact extra', '/压缩 extra', '/export path', '/model extra', '/file path',
    '/plan inspect', '/计划 inspect', '/goal finish', '/权限 read-only', '/反馈 problem',
    '/导出', '/export', '/model', '/file'])('leaves %j as ordinary text', (text) => {
    expect(queryCommand(text, commands)).toBeUndefined()
  })

  it('does not apply an alias to an unrelated scoped replacement', () => {
    const replaced = [{ name: 'compact', description: 'Scoped command' }]
    expect(queryCommand('/compact', replaced)).toBe('/compact')
    expect(queryCommand('/压缩', replaced)).toBeUndefined()
  })

  it('leaves other registered commands and unavailable compact unchanged', () => {
    expect(queryCommand('/plan', commands)).toBeUndefined()
    expect(queryCommand('/compact', [])).toBeUndefined()
    expect(queryCommand('/export', [])).toBeUndefined()
    expect(queryCommand('/压缩', [{ name: 'prune', definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-compact'), description: 'Renamed command' }]))
      .toBeUndefined()
  })

})
