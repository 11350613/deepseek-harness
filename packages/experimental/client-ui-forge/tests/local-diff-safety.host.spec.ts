/** Real Git helpers and filtered files under the panel's command-local restrictions. */
import { createHash } from 'node:crypto'
import { access, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { inspectCheckout } from '../src/git.ts'
import { localChanges, localDiff } from '../src/local-diff.ts'
import type { DiffConfig } from '../src/local-diff.ts'
import { git, gitContext, plainSession, repository, sandboxRecord, scratch } from './harness.ts'

const CONFIG: DiffConfig = {
  gitCommand: 'git', gitTimeoutMs: 10_000, graceMs: 500, maxOutputBytes: 1_048_576, maxDiffBytes: 1_048_576, maxUntrackedFiles: 100,
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup() {
  const { path: root, remove } = await scratch('dsh-forge-diff-helpers-')
  cleanups.push(remove)
  const repo = await repository(root)
  const ctx = await gitContext(sandboxRecord(), repo)
  cleanups.push(() => ctx.fiber.dispose())
  const session = plainSession(repo)
  setSandboxMode(session, 'danger-full-access')
  const signal = new AbortController().signal
  const fork = { commit: await git(repo, 'rev-parse', 'HEAD'), label: 'main' }
  await git(repo, 'remote', 'add', 'origin', 'https://example.invalid/repo')
  await git(repo, 'update-ref', 'refs/remotes/origin/main', fork.commit)
  await git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  const inspection = await inspectCheckout(ctx, CONFIG, session, repo, signal)
  if (inspection === undefined) throw new Error('fixture checkout is missing')
  const marker = join(root, 'executed')
  const script = join(root, 'helper.cjs')
  await writeFile(script, `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'ran');
if (process.argv[2] === 'clean') process.stdout.write('converted\\n' + fs.readFileSync(0, 'utf8'));
else process.exit(1);
`)
  const quote = (value: string): string => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`
  const command = `${quote(process.execPath)} ${quote(script)}`
  return { root, repo, ctx, session, signal, fork, inspection, marker, command }
}

describe('diff helper restrictions', () => {
  it.each(['named', 'some.nested.driver', 'x=y', 'lfs'])('disables the required clean filter %s for patches and statistics without changing Git config or index', async (driver) => {
    const b = await setup()
    await writeFile(join(b.repo, '.gitattributes'), `tracked.txt filter=${driver} -text\n`)
    await git(b.repo, 'config', `filter.${driver}.clean`, `${b.command} clean`)
    await git(b.repo, 'config', `filter.${driver}.required`, 'true')
    await git(b.repo, 'config', `filter.${driver}.unused`, 'preserved')
    await writeFile(join(b.repo, 'tracked.txt'), 'changed\n')
    await git(b.repo, 'diff', '--no-ext-diff', '--no-textconv')
    expect(await readFile(b.marker, 'utf8')).toBe('ran')
    await rm(b.marker)
    const config = await readFile(join(b.repo, '.git', 'config'))
    const index = await readFile(join(b.repo, '.git', 'index'))
    const indexStat = await stat(join(b.repo, '.git', 'index'))

    const diff = await localDiff(b.ctx, CONFIG, b.session, b.repo, b.fork, { kind: 'unstaged' }, b.signal)
    const changes = await localChanges(b.ctx, CONFIG, b.session, b.inspection, null, b.signal)

    expect(diff.files.find(file => file.path === 'tracked.txt')?.hunks.flatMap(hunk => hunk.lines)).toEqual(['-initial', '+changed'])
    expect(changes?.files.find(file => file.path === 'tracked.txt')).toMatchObject({ additions: 1, deletions: 1 })
    await expect(access(b.marker)).rejects.toThrow()
    expect(await readFile(join(b.repo, '.git', 'config'))).toEqual(config)
    expect(await readFile(join(b.repo, '.git', 'index'))).toEqual(index)
    expect((await stat(join(b.repo, '.git', 'index'))).mtimeMs).toBe(indexStat.mtimeMs)
  })

  it('disables a required process filter that refuses ordinary diff', async () => {
    const b = await setup()
    await writeFile(join(b.repo, '.gitattributes'), 'tracked.txt filter=process-driver\n')
    await git(b.repo, 'config', 'filter.process-driver.process', b.command)
    await git(b.repo, 'config', 'filter.process-driver.required', 'true')
    await writeFile(join(b.repo, 'tracked.txt'), 'changed\n')
    await expect(git(b.repo, 'diff')).rejects.toThrow()
    expect(await readFile(b.marker, 'utf8')).toBe('ran')
    await rm(b.marker)

    await localDiff(b.ctx, CONFIG, b.session, b.repo, b.fork, { kind: 'unstaged' }, b.signal)
    await localChanges(b.ctx, CONFIG, b.session, b.inspection, null, b.signal)
    await expect(access(b.marker)).rejects.toThrow()
  })

  it.each(['diff.external', 'diff.helper.textconv', 'core.fsmonitor'])('does not execute %s', async (key) => {
    const b = await setup()
    await writeFile(join(b.repo, '.gitattributes'), 'tracked.txt diff=helper\n')
    await git(b.repo, 'config', key, b.command)
    await writeFile(join(b.repo, 'tracked.txt'), 'changed\n')

    await localDiff(b.ctx, CONFIG, b.session, b.repo, b.fork, { kind: 'unstaged' }, b.signal)
    await localChanges(b.ctx, CONFIG, b.session, b.inspection, null, b.signal)
    await expect(access(b.marker)).rejects.toThrow()
  })

  it('ignores dirty submodule files and helpers while retaining submodule commit changes', async () => {
    const b = await setup()
    const source = await repository(b.root, 'source')
    await git(b.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'nested')
    await git(b.repo, 'commit', '-m', 'submodule')
    const nested = join(b.repo, 'nested')
    await writeFile(join(nested, 'tracked.txt'), 'dirty\n')
    await git(nested, 'config', 'core.fsmonitor', b.command)
    await git(b.repo, 'config', 'diff.submodule', 'diff')
    const clean = await localDiff(b.ctx, CONFIG, b.session, b.repo, null, { kind: 'unstaged' }, b.signal)
    expect(clean.files).toEqual([])
    await expect(access(b.marker)).rejects.toThrow()

    await git(nested, 'config', '--unset', 'core.fsmonitor')
    await git(nested, 'config', 'user.name', 'Forge fixture')
    await git(nested, 'config', 'user.email', 'forge@example.invalid')
    await git(nested, '-c', 'commit.gpgSign=false', 'commit', '-am', 'nested change')
    await git(nested, 'config', 'core.fsmonitor', b.command)
    const changed = await localDiff(b.ctx, CONFIG, b.session, b.repo, null, { kind: 'unstaged' }, b.signal)
    expect(changed.files.map(file => file.path)).toEqual(['nested'])
    expect(changed.files[0]?.hunks.flatMap(hunk => hunk.lines).join('\n')).toContain('Subproject commit')
    await expect(access(b.marker)).rejects.toThrow()
  })

  it('refuses an incomplete filter listing before running a diff', async () => {
    const b = await setup()
    await git(b.repo, 'config', `filter.${'long'.repeat(200)}.clean`, b.command)
    await writeFile(join(b.repo, '.gitattributes'), `tracked.txt filter=${'long'.repeat(200)}\n`)
    await writeFile(join(b.repo, 'tracked.txt'), 'changed\n')
    await expect(localDiff(b.ctx, { ...CONFIG, maxDiffBytes: 128 }, b.session, b.repo, null, { kind: 'unstaged' }, b.signal))
      .rejects.toThrow('output exceeds maxOutputBytes')
    await expect(access(b.marker)).rejects.toThrow()
  })

  it('compares LFS pointers and materialized bytes without invoking LFS or downloading content', async () => {
    const b = await setup()
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 4\n`
    await writeFile(join(b.repo, 'asset.bin'), pointer)
    await writeFile(join(b.repo, '.gitattributes'), 'asset.bin filter=lfs -text\n')
    await git(b.repo, 'add', '.gitattributes', 'asset.bin')
    await git(b.repo, 'commit', '-m', 'pointer')
    await git(b.repo, 'config', 'filter.lfs.process', b.command)
    await git(b.repo, 'config', 'filter.lfs.required', 'true')
    await expect(localDiff(b.ctx, CONFIG, b.session, b.repo, null, { kind: 'unstaged' }, b.signal)).resolves.toMatchObject({ files: [] })
    await writeFile(join(b.repo, 'asset.bin'), Uint8Array.from([0, 1, 2, 3]))
    const diff = await localDiff(b.ctx, CONFIG, b.session, b.repo, null, { kind: 'unstaged' }, b.signal)
    expect(diff.files).toMatchObject([{ path: 'asset.bin', binary: true, hunks: [] }])
    await expect(access(b.marker)).rejects.toThrow()
  })

  it('shows raw materialized LFS text even when its configured conversion matches the stored pointer', async () => {
    const b = await setup()
    const content = 'materialized content\n'
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${createHash('sha256').update(content).digest('hex')}\nsize ${Buffer.byteLength(content)}\n`
    await writeFile(join(b.repo, 'asset.txt'), pointer)
    await writeFile(join(b.repo, '.gitattributes'), 'asset.txt filter=lfs -text\n')
    await git(b.repo, 'add', '.gitattributes', 'asset.txt')
    await git(b.repo, 'commit', '-m', 'pointer')
    await writeFile(join(b.root, 'helper.cjs'), `const fs = require('node:fs'); fs.readFileSync(0); fs.writeFileSync(${JSON.stringify(b.marker)}, 'ran'); process.stdout.write(${JSON.stringify(pointer)});\n`)
    await git(b.repo, 'config', 'filter.lfs.clean', b.command)
    await git(b.repo, 'config', 'filter.lfs.required', 'true')
    await writeFile(join(b.repo, 'asset.txt'), content)
    expect(await git(b.repo, 'diff', '--numstat')).toBe('')
    expect(await readFile(b.marker, 'utf8')).toBe('ran')
    await rm(b.marker)

    const diff = await localDiff(b.ctx, CONFIG, b.session, b.repo, null, { kind: 'unstaged' }, b.signal)
    expect(diff.files).toMatchObject([{ path: 'asset.txt', additions: 1, deletions: 3 }])
    await expect(access(b.marker)).rejects.toThrow()
  })
})
