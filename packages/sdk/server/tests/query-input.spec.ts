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
    ['/permission workspace-write', '/permission workspace-write'],
    [' \n/权限\tread-only \t', '/permission\tread-only'],
    ['/permission\ncustom-deployment-preset', '/permission\ncustom-deployment-preset'],
    ['/permission  missing extra', '/permission  missing extra'],
    ['/plan', '/plan'], ['/计划', '/plan'], [' \n/plan off\t ', '/plan off'],
    ['/计划\nDesign the change', '/plan\nDesign the change'],
    ['/plan  off extra', '/plan  off extra'],
  ])('recognizes the Desktop form %j', (text, expected) => {
    expect(queryCommand(text, commands)).toBe(expected)
  })

  it.each(['ordinary text', '/', '/unknown', '/usr/bin', '/COMPACT', '/模型', '/文件',
    '/compact extra', '/压缩 extra', '/export path', '/model extra', '/file path',
    '/plans inspect', '/goal finish', '/反馈 problem',
    '/permission', ' \n/permission \t', '/权限', '/权限\n\t', '/permissions read-only',
    '/导出', '/export', '/model', '/file'])('leaves %j as ordinary text', (text) => {
    expect(queryCommand(text, commands)).toBeUndefined()
  })

  it('does not apply an alias to an unrelated scoped replacement', () => {
    const replaced = [{ name: 'compact', description: 'Scoped command' }, { name: 'permission', description: 'Scoped permission' }]
    expect(queryCommand('/compact', replaced)).toBe('/compact')
    expect(queryCommand('/压缩', replaced)).toBeUndefined()
    expect(queryCommand('/permission read-only', replaced)).toBe('/permission read-only')
    expect(queryCommand('/权限 read-only', replaced)).toBeUndefined()
    expect(queryCommand('/计划', [{ name: 'plan', description: 'Scoped plan' }])).toBeUndefined()
  })

  it('leaves other registered commands and unavailable supported commands unchanged', () => {
    expect(queryCommand('/goal', commands)).toBeUndefined()
    expect(queryCommand('/plan', [])).toBeUndefined()
    expect(queryCommand('/compact', [])).toBeUndefined()
    expect(queryCommand('/export', [])).toBeUndefined()
    expect(queryCommand('/permission read-only', [])).toBeUndefined()
    expect(queryCommand('/压缩', [{ name: 'prune', definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-compact'), description: 'Renamed command' }]))
      .toBeUndefined()
    expect(queryCommand('/权限 read-only', [{ name: 'access', definitionId: CommandDefinitionId('@deepseek-ai/dsh-permission-presets'), description: 'Renamed permission' }]))
      .toBeUndefined()
    expect(queryCommand('/计划', [{ name: 'planning', definitionId: CommandDefinitionId('@deepseek-ai/dsh-plan-mode'), description: 'Renamed plan' }]))
      .toBeUndefined()
  })

  it('preserves exact-name priority over localized aliases', () => {
    const shadowed = [...commands, { name: '权限', description: 'Another definition' }]
    expect(queryCommand('/权限 read-only', shadowed)).toBeUndefined()
  })
})
