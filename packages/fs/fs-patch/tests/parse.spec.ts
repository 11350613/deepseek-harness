/** Parser compatibility cases adapted from OpenAI Codex rust-v0.158.0 (Apache-2.0; see ../LICENSE). */

import { describe, expect, it } from 'vitest'
import { collectMutationPaths, parsePatch, PatchParseError } from '../src/index.ts'

function patch(...lines: string[]): string {
  return ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')
}

describe('parsePatch', () => {
  it('preserves file order, repeated paths, move endpoints, and explicit context indices', () => {
    const input = patch(
      '*** Add File: dir/a.txt', '+hello', '+',
      '*** Update File: dir/a.txt', '*** Move to: dir/b.txt',
      '@@ hello', '-hello', '+hi', '+there', ' same', '-same', '+same',
      '@@', ' last', '+tail', '*** End of File',
      '*** Delete File: /tmp/obsolete',
      '*** Add File: dir/a.txt',
    )
    const operations = parsePatch(input)
    expect(operations).toEqual([
      { kind: 'add', path: 'dir/a.txt', lineNumber: 2, content: 'hello\n\n' },
      {
        kind: 'update', path: 'dir/a.txt', lineNumber: 5, moveTo: 'dir/b.txt',
        hunks: [
          {
            lineNumber: 7, context: 'hello', oldLines: ['hello', 'same', 'same'],
            newLines: ['hi', 'there', 'same', 'same'], contextLineIndices: [[1, 2]], isEndOfFile: false,
          },
          {
            lineNumber: 14, oldLines: ['last'], newLines: ['last', 'tail'],
            contextLineIndices: [[0, 0]], isEndOfFile: true,
          },
        ],
      },
      { kind: 'delete', path: '/tmp/obsolete', lineNumber: 18 },
      { kind: 'add', path: 'dir/a.txt', lineNumber: 19, content: '' },
    ])
    expect(JSON.parse(JSON.stringify(operations))).toEqual(operations)
    expect(collectMutationPaths(operations)).toEqual(['dir/a.txt', 'dir/b.txt', '/tmp/obsolete'])
    expect(operations).toHaveLength(4)
  })

  it('accepts an empty patch and empty creation', () => {
    expect(parsePatch(patch())).toEqual([])
    expect(parsePatch(patch('*** Add File: empty'))).toEqual([
      { kind: 'add', path: 'empty', lineNumber: 2, content: '' },
    ])
  })

  it.each(['<<EOF', "<<'EOF'", '<<"EOF"'])('unwraps the literal %s form without evaluating shell text', (wrapper) => {
    expect(parsePatch(`\n${wrapper}\n${patch('*** Add File: $(touch sentinel)', '+`literal` $HOME')}\nEOF\n`)).toEqual([
      { kind: 'add', path: '$(touch sentinel)', lineNumber: 4, content: '`literal` $HOME\n' },
    ])
  })

  it('follows the upstream heredoc terminator suffix rule', () => {
    expect(parsePatch(`<<EOF\n${patch()}\nanythingEOF`)).toEqual([])
  })

  it.each(['\n', '\r\n', '\r\r\n'])('normalizes patch line endings %j', (newline) => {
    expect(parsePatch(patch('*** Add File: a', '+a', '+b').replaceAll('\n', newline))).toEqual([
      { kind: 'add', path: 'a', lineNumber: 2, content: 'a\nb\n' },
    ])
  })

  it('retains content whitespace and treats a bare empty line as context', () => {
    expect(parsePatch(patch('*** Update File: a', '-a\t ', '+b  ', '', ' \t', '@@ anchor  ', '+c'))).toEqual([
      {
        kind: 'update', path: 'a', lineNumber: 2,
        hunks: [
          {
            lineNumber: 3, oldLines: ['a\t ', '', '\t'], newLines: ['b  ', '', '\t'],
            contextLineIndices: [[1, 1], [2, 2]], isEndOfFile: false,
          },
          {
            lineNumber: 7, context: 'anchor', oldLines: [], newLines: ['c'],
            contextLineIndices: [], isEndOfFile: false,
          },
        ],
      },
    ])
  })

  it.each(['', ' ', '+new', '-old'])('accepts an implicit first hunk beginning with %j', (line) => {
    const [operation] = parsePatch(patch('*** Update File: a', line))
    expect(operation).toMatchObject({ kind: 'update', hunks: [{ lineNumber: 3 }] })
  })

  it('keeps indented patch markers as update context', () => {
    const context = ['*** Add File: b', '*** Delete File: c', '*** Update File: d', '*** End Patch', '*** Move to: e', '*** End of File', '@@', '*** Environment ID: e']
    const [operation] = parsePatch(patch('*** Update File: a', ...context.map(line => ` ${line}`)))
    expect(operation).toMatchObject({
      kind: 'update', path: 'a', hunks: [{ oldLines: context, newLines: context }],
    })
  })

  it('trims header whitespace but preserves path spelling and Unicode content', () => {
    expect(parsePatch('\u0085 \n *** Begin Patch \t\n *** Add File: ../a/./文件 \t\n+é é \t\n *** End Patch\u0085')).toEqual([
      { kind: 'add', path: '../a/./文件', lineNumber: 3, content: 'é é \t\n' },
    ])
  })

  it('supports blank lines after EOF, then a new hunk or file', () => {
    const operations = parsePatch(patch(
      '*** Update File: a', '@@', '-a', '+b', '*** End of File', '', ' \t',
      '@@ next', '+c', '*** End of File', '*** Delete File: b',
    ))
    expect(operations).toMatchObject([
      { kind: 'update', hunks: [{ isEndOfFile: true }, { context: 'next', isEndOfFile: true }] },
      { kind: 'delete', path: 'b' },
    ])
  })

  it('follows upstream handling of EOF before the first hunk', () => {
    expect(parsePatch(patch('*** Update File: a', '*** End of File', '+a'))).toMatchObject([
      { kind: 'update', hunks: [{ newLines: ['a'], isEndOfFile: false }] },
    ])
  })

  it('accepts a trimmed final marker and upstream redundant final marker', () => {
    expect(parsePatch('*** Begin Patch\n*** Update File: a\n+x\n \t*** End Patch \t\n')).toHaveLength(1)
    expect(parsePatch(patch('*** End Patch', ' \t'))).toEqual([])
  })

  it.each([
    ['', 1, 'Begin Patch'],
    ['not a patch', 1, 'Begin Patch'],
    ['*** Begin Patch', 1, 'End Patch'],
    ['*** Begin Patch\n*** Add File: a\n+x', 3, 'End Patch'],
    ['\uFEFF*** Begin Patch\n*** End Patch', 1, 'Begin Patch'],
    ['<<EOF\nbad\n*** End Patch\nEOF', 2, 'Begin Patch'],
    ['<<EOF\n*** Begin Patch\nbad\nEOF', 3, 'End Patch'],
    ['<<EOF\n*** Begin Patch\n*** End Patch\nSTOP', 1, 'Begin Patch'],
    ['<<EOF\n*** End Patch\nEOF', 1, 'Begin Patch'],
    ['apply_patch <<EOF\n*** Begin Patch\n*** End Patch\nEOF', 1, 'Begin Patch'],
    ['--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b', 1, 'Begin Patch'],
    [patch(''), 2, 'header'],
    [patch('*** Add File: '), 2, 'header'],
    [patch('*** Unknown: a'), 2, 'header'],
    [patch('*** Add File: a', 'unprefixed'), 3, 'header'],
    [patch('*** Delete File: a', '+content'), 3, 'header'],
    [patch('*** Move to: b'), 2, 'header'],
    [patch('*** Update File: a'), 2, 'requires at least one hunk'],
    [patch('*** Update File: a', '*** Move to: b'), 2, 'requires at least one hunk'],
    [patch('*** Update File: a', '*** Move to: b', '*** Move to: c'), 4, 'context'],
    [patch('*** Update File: a', '@@', '*** Move to: b'), 4, 'context'],
    [patch('*** Update File: a', 'unprefixed'), 3, 'context'],
    [patch('*** Update File: a', '@@'), 4, 'must contain'],
    [patch('*** Update File: a', '@@', '@@ next'), 4, 'must contain'],
    [patch('*** Update File: a', '@@', '*** End of File'), 4, 'must contain'],
    [patch('*** Update File: a', '@@', '*** Add File: b'), 4, 'must contain'],
    [patch('*** Update File: a', '*** Delete File: b'), 2, 'requires at least one hunk'],
    [patch('*** Update File: a', '+a', '*** End of File', '+b'), 5, "Expected '@@'"],
    [patch('*** End Patch', '+later'), 3, 'after'],
    [patch('*** Environment ID: env-1'), 2, 'unsupported'],
    [patch('*** Environment ID:'), 2, 'unsupported'],
  ])('rejects malformed or unsupported input %# at its original line', (input, lineNumber, reason) => {
    expect(() => parsePatch(input)).toThrow(PatchParseError)
    expect(() => parsePatch(input)).toThrow(expect.objectContaining({
      name: 'PatchParseError', lineNumber,
    }))
    try {
      parsePatch(input)
    } catch (error) {
      if (!(error instanceof PatchParseError)) throw error
      expect(error.reason).toContain(reason)
      expect(error.message).toContain(`line ${lineNumber}:`)
    }
  })

  it('counts leading lines and heredoc lines in diagnostics', () => {
    expect(() => parsePatch(`\n \n<<'EOF'\n${patch('*** Update File: a', '@@')}\nEOF`)).toThrow(
      expect.objectContaining({ lineNumber: 7 }),
    )
  })
})

describe('collectMutationPaths', () => {
  it('returns an empty list for no operations', () => {
    expect(collectMutationPaths([])).toEqual([])
  })

  it('deduplicates exact spellings without resolving aliases or changing operations', () => {
    const operations = parsePatch(patch(
      '*** Update File: a', '*** Move to: b', '+x',
      '*** Update File: b', '*** Move to: b', '+y',
      '*** Update File: ./a', '+z',
      '*** Delete File: a', '*** Add File: ../a',
      '*** Add File: C:\\dir\\a', '*** Delete File: /a',
    ))
    const before = JSON.stringify(operations)
    expect(collectMutationPaths(operations)).toEqual(['a', 'b', './a', '../a', 'C:\\dir\\a', '/a'])
    expect(JSON.stringify(operations)).toBe(before)
  })
})
