/** The ordinary unit lane executes the native application publication regressions. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it.skipIf(process.platform === 'win32')('preserves signed generations and rejects incomplete application publication', () => {
  const output = execFileSync('python3', [fileURLToPath(new URL('../native/tests/test_build_app.py', import.meta.url))], {
    encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  })
  expect(output).toBe('')
})
