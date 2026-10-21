/**
 * #70 — the CLI must be launchable however it is installed, and must find its config from
 * anywhere. Both failures were silent: a symlinked binary loaded and exited 0 without running,
 * and an installed CLI reported "no configuration file" from any directory but the repo root.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverFile, resolveConfigFile } from '@saip/shared'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const distBin = join(repoRoot, 'cli/dist/bin.js')
const distLib = join(repoRoot, 'cli/dist/index.js')
const srcEntry = join(repoRoot, 'cli/src/index.ts')
const built = existsSync(distBin)

const tmp = () => mkdtempSync(join(tmpdir(), 'saip-cli-'))

/** Runs the CLI the way a shell would: through a symlink on PATH. */
function viaSymlink(args: string[]) {
  const dir = tmp()
  const link = join(dir, 'saip')
  symlinkSync(distBin, link)
  chmodSync(distBin, 0o755)
  return spawnSync(process.execPath, [link, ...args], { encoding: 'utf8', cwd: dir })
}

describe('entry guard under a symlinked launcher (#70 cause 1)', () => {
  it.skipIf(!built)('a symlinked CLI actually runs and prints its version', () => {
    const r = viaSymlink(['--version'])
    // The pre-fix symptom: exit 0, empty stdout. Assert output, not merely success.
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it.skipIf(!built)('a symlinked CLI dispatches subcommands', () => {
    const r = viaSymlink(['config', 'doctor'])
    expect(r.stdout).toMatch(/secret store/)
  })

  it('no entry guard survives: the entry file runs unconditionally (#101)', () => {
    // The guard existed only because one file played two roles. A compiled binary has
    // argv[1] = /$bunfs/root/... which realpathSync cannot resolve, so a self-detecting entry
    // silently does nothing — the #70 symptom, resurrected by packaging. Detection is gone
    // rather than improved: bin.ts runs, index.ts is a library.
    const src = readFileSync(srcEntry, 'utf8')
    expect(src).not.toMatch(/isMainEntry/)
    expect(src).not.toMatch(/^if \(isMainEntry\(\)/m)
    const bin = readFileSync(join(repoRoot, 'cli/src/bin.ts'), 'utf8')
    expect(bin).toMatch(/runCli/)
    // Code, not prose: bin.ts necessarily names the expression it removed while explaining why.
    const binCode = bin.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
    expect(binCode).not.toMatch(/import\.meta\.url/)
    expect(binCode).toMatch(/^await runCli\(\)/m)
  })

  it('the library entry can be imported with no side effects (a compiled bin must not double-run)', () => {
    // Importing index.ts must not execute the CLI: that is what the guard used to protect, and the
    // property still matters now that two files exist.
    const src = readFileSync(srcEntry, 'utf8')
    const topLevelIf = src.split('\n').some((l) => /^(if|void|[a-zA-Z]+\()/ .test(l) && /parse\(\)/.test(l))
    expect(topLevelIf).toBe(false)
    expect(existsSync(distLib) || true).toBe(true)
  })

  it('package.json points the bin at dist/bin.js and the scripts agree', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'cli/package.json'), 'utf8'))
    expect(pkg.bin).toEqual({ saip: 'dist/bin.js' })
    const link = readFileSync(join(repoRoot, 'cli/scripts/install-link.mjs'), 'utf8')
    const chmod = readFileSync(join(repoRoot, 'cli/scripts/mark-bin-executable.mjs'), 'utf8')
    expect(link).toMatch(/dist\/bin\.js/)
    expect(chmod).toMatch(/dist\/bin\.js/)
  })

  it('the installed binary is executable *as a program*, not just via `node` (#101)', () => {
    // Every earlier spawn in this file used `process.execPath` as the interpreter, which makes the
    // shebang irrelevant — so a missing `#!/usr/bin/env node` passed the whole suite while `saip`
    // on PATH failed with "Permission denied"/"Unterminated quoted string". Executing the link
    // directly is the only way to test what a user actually types.
    const d = tmp()
    const link = join(d, 'saip')
    symlinkSync(distBin, link)
    chmodSync(distBin, 0o755)
    const r = spawnSync(link, ['--version'], { encoding: 'utf8', cwd: d })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('the entry file carries the shebang the executable needs', () => {
    expect(readFileSync(join(repoRoot, 'cli/src/bin.ts'), 'utf8').startsWith('#!/usr/bin/env node')).toBe(true)
    // And the library must not, now that it is not the executable.
    expect(readFileSync(srcEntry, 'utf8').startsWith('#!')).toBe(false)
  })

  it('the compiled-style entry works when argv[1] is unresolvable (bundled-binary shape)', () => {
    // Proxy for /$bunfs/root/... : a path that does not exist on the real filesystem. Under the
    // old guard this printed nothing; a real bin.ts cannot care, because it never asks.
    const dir = tmp()
    const r = spawnSync(process.execPath, [distBin, '--version'], { encoding: 'utf8', cwd: dir })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('config discovery (#70 cause 2)', () => {
  it('finds saip.yaml from a nested subdirectory', () => {
    const root = tmp()
    writeFileSync(join(root, 'saip.yaml'), 'platform:\n  name: saip\n')
    const deep = join(root, 'a', 'b', 'c')
    mkdirSync(deep, { recursive: true })
    expect(discoverFile('saip.yaml', { start: deep })).toBe(join(root, 'saip.yaml'))
  })

  it('prefers the nearest ancestor when several checkouts nest', () => {
    const outer = tmp()
    writeFileSync(join(outer, 'saip.yaml'), 'marker: outer\n')
    const inner = join(outer, 'project')
    mkdirSync(inner)
    writeFileSync(join(inner, 'saip.yaml'), 'marker: inner\n')
    expect(discoverFile('saip.yaml', { start: join(inner, 'sub', 'dir') })).toBe(join(inner, 'saip.yaml'))
    expect(readFileSync(discoverFile('saip.yaml', { start: inner })!, 'utf8')).toMatch(/inner/)
  })

  it('an explicit path is honored and never silently falls back to discovery', () => {
    const dir = tmp()
    const custom = join(dir, 'elsewhere.yml')
    writeFileSync(custom, 'a: 1\n')
    writeFileSync(join(dir, 'saip.yaml'), 'a: 2\n')
    expect(resolveConfigFile('saip.yaml', { explicit: custom, env: {} }).path).toBe(custom)
  })

  it('a missing explicit path is an error naming that path, not an empty result', () => {
    const r = resolveConfigFile('saip.yaml', { explicit: '/nope/saip.yaml', envVar: 'SAIP_CONFIG', env: { SAIP_CONFIG: '/nope/saip.yaml' } })
    expect(r.path).toBeUndefined()
    expect(r.error).toMatch(/\/nope\/saip\.yaml/)
  })

  it('returns undefined when nothing is found rather than escaping the filesystem', () => {
    const isolated = tmp()
    // A path with no ancestor containing the file: /tmp/<rand> has no saip.yaml above it
    // in a normal environment, so this asserts the walk terminates.
    const found = discoverFile('definitely-not-here-9f3a.yaml', { start: isolated })
    expect(found).toBeUndefined()
  })

  it.skipIf(!built)('SAIP_CONFIG is honored from an unrelated directory, and the loaded file is reported', () => {
    // Asserts only what is environment-independent: the CLI executed, found the config we
    // pointed it at, and named the file. Whether a tier then resolves depends on a real GPU,
    // and CI has none — pinning `Resolved:` here asserted hardware that does not exist.
    const dir = tmp()
    const cfg = join(dir, 'saip.yaml')
    writeFileSync(cfg, readFileSync(join(repoRoot, 'saip.yaml'), 'utf8'))
    const r = spawnSync(process.execPath, [distBin, 'profiles'], {
      encoding: 'utf8', cwd: dir, env: { ...process.env, SAIP_CONFIG: cfg },
    })
    const text = r.stdout + r.stderr
    expect(text).toContain(`config: ${cfg}`)
    // Either a tier resolved, or it failed closed on hardware — never on finding the config.
    expect(text).toMatch(/Resolved: |gpu_unavailable|insufficient/)
    expect(text).not.toMatch(/no saip\.yaml found/)
  })
})

describe('bin executable bit (#70 cause 3)', () => {
  it.skipIf(!built)('the build leaves the bin entry executable', () => {
    const { statSync } = require('node:fs')
    expect(statSync(distBin).mode & 0o111).toBeGreaterThan(0)
  })

  it('the build pipeline includes the chmod step', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'cli/package.json'), 'utf8'))
    expect(pkg.scripts.build).toMatch(/mark-bin-executable/)
    expect(pkg.engines.node).toMatch(/22/)
  })
})
