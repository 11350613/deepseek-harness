/** Final application bytes and source identity survive packaging; invalid inputs never reach publication. */
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { create } from 'tar'
import { expect, it, onTestFinished } from 'vitest'
import { CUA_APPLICATION, CUA_ARCHITECTURES, CUA_MANIFEST, cuaApplicationDigest, readCuaApplication, sealCuaApplication, stageCuaHelperPayload, verifyCuaHelperPayload } from './payload.ts'
import { verifyCuaHelperTarball } from './verify-tarball.ts'

const identity = { version: '1.0.0', commit: 'a'.repeat(40) }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cua-payload-test-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const payload = join(root, 'payload')
  const applications = CUA_ARCHITECTURES.map((architecture) => {
    const directory = join(payload, 'native/bin', `darwin-${architecture}`)
    const application = join(directory, 'unsigned', CUA_APPLICATION)
    for (const [path, bytes] of Object.entries({
      'Contents/Info.plist': 'fixture identity', 'Contents/MacOS/dsh-cua-native': `executable ${architecture}`,
      'Contents/Resources/DSHComputerUse.icns': 'icon', 'Contents/_CodeSignature/CodeResources': 'signature',
    })) {
      mkdirSync(join(application, path, '..'), { recursive: true })
      writeFileSync(join(application, path), bytes)
    }
    chmodSync(join(application, 'Contents/MacOS/dsh-cua-native'), 0o755)
    return { architecture, bundle: sealCuaApplication(directory, application) }
  })
  const manifest = { schemaVersion: 1, ...identity, teamId: 'ABCDEFGHIJ', applications }
  writeFileSync(join(payload, CUA_MANIFEST), JSON.stringify(manifest))
  return { root, payload, manifest, directory: join(payload, 'native/bin/darwin-arm64') }
}

it.skipIf(process.platform === 'win32')('matches the native build receipt hash and includes post-signing ticket bytes', () => {
  const f = fixture()
  const before = readCuaApplication(f.directory)
  const script = resolve('packages/experimental/cua-macos/native/build_app.py')
  const digest = execFileSync('python3', ['-c', 'import runpy,sys; from pathlib import Path; print(runpy.run_path(sys.argv[1])["bundle_digest"](Path(sys.argv[2])))', script, before.application], { encoding: 'utf8' }).trim()
  expect(cuaApplicationDigest(before.application)).toBe(digest)
  writeFileSync(join(before.application, 'Contents/ticket'), 'notarization ticket')
  expect(() => readCuaApplication(f.directory)).toThrow('digest')
  const after = sealCuaApplication(f.directory, before.application)
  expect(after).not.toBe(before.bundle)
  expect(readFileSync(join(readCuaApplication(f.directory).application, 'Contents/ticket'), 'utf8')).toBe('notarization ticket')
})

it.skipIf(process.platform === 'win32')('verifies staged and repacked provider bytes before publication', async () => {
  const f = fixture()
  expect(verifyCuaHelperPayload(f.payload, identity)).toEqual(f.manifest)
  const packageRoot = join(f.root, 'package')
  stageCuaHelperPayload(f.payload, packageRoot, identity)
  expect(() => { stageCuaHelperPayload(f.payload, packageRoot, identity) }).toThrow('empty native/bin')
  const tarball = join(f.root, 'provider.tgz')
  await create({ file: tarball, cwd: f.root, gzip: true, portable: true }, ['package'])
  await verifyCuaHelperTarball(tarball, identity)
  const application = readCuaApplication(join(packageRoot, 'native/bin/darwin-arm64')).application
  writeFileSync(join(application, 'Contents/MacOS/dsh-cua-native'), 'changed after signing')
  await create({ file: tarball, cwd: f.root, gzip: true, portable: true }, ['package'])
  await expect(verifyCuaHelperTarball(tarball, identity)).rejects.toThrow('digest')
})

it.skipIf(process.platform === 'win32').each(['version', 'commit', 'architecture', 'missing', 'extra', 'permissions', 'symlink'] as const)('rejects %s damage before staging', (damage) => {
  const f = fixture()
  const before = readCuaApplication(f.directory)
  if (damage === 'version') f.manifest.version = '2.0.0'
  if (damage === 'commit') f.manifest.commit = 'b'.repeat(40)
  if (damage === 'architecture') f.manifest.applications[1] = f.manifest.applications[0]!
  if (damage === 'missing') rmSync(join(before.application, 'Contents/Info.plist'))
  if (damage === 'extra') cpSync(before.application, join(f.directory, 'old-generation', CUA_APPLICATION), { recursive: true })
  if (damage === 'permissions') chmodSync(join(before.application, 'Contents/MacOS/dsh-cua-native'), 0o644)
  if (damage === 'symlink') symlinkSync(join(f.root, 'outside'), join(before.application, 'outside'))
  writeFileSync(join(f.payload, CUA_MANIFEST), JSON.stringify(f.manifest))
  expect(() => { stageCuaHelperPayload(f.payload, join(f.root, 'consumer'), identity) }).toThrow()
})

it('keeps company signing outside pull-request release rehearsals', () => {
  const workflow = readFileSync(resolve('.github/workflows/cua-helper-package.yml'), 'utf8')
  expect(workflow).toContain('workflow_dispatch:')
  expect(workflow).toContain('workflow_call:')
  expect(workflow).not.toContain('pull_request:')
  expect(workflow).toContain('dsh-mac-package-trial')
  const release = readFileSync(resolve('.github/workflows/release-publish.yml'), 'utf8')
  expect(release).toContain('needs: cua-helper')
  expect(release).toContain('scripts/cua-helper/stage.ts')
  expect(readFileSync(resolve('.github/workflows/release.yml'), 'utf8')).not.toContain('cua-helper-package.yml')
})
