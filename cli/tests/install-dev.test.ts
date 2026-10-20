/**
 * Installing a compiled dev binary as `saip-dev` (#119). The pure decisions are asserted directly; the
 * whole path is asserted by EXECUTING the installed binary, because every "it copied fine" claim in this
 * repo has ended with something that does not run (#70, #101, #71).
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  binDir, metaPath, readsInstalled, classifyExisting, provenanceMismatch, parseBuilt,
} from '../scripts/install-dev-lib.mjs'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const manifestVersion = JSON.parse(readFileSync(join(repoRoot, 'cli/package.json'), 'utf8')).version

describe('where it goes and what may be overwritten (#119)', () => {
  it('defaults to ~/.local/bin and honours SAIP_DEV_BINDIR', () => {
    expect(binDir({}, '/home/u')).toBe('/home/u/.local/bin')
    expect(binDir({ SAIP_DEV_BINDIR: '/tmp/other' }, '/home/u')).toBe('/tmp/other')
  })

  it('a missing destination is installable; our own previous build is replaceable', () => {
    expect(classifyExisting({ exists: false, meta: true }).action).toBe('install')
    expect(classifyExisting({ exists: true, meta: true }).action).toBe('install')
  })

  it('an unknown file at the destination is refused, not clobbered — and --force overrides', () => {
    const r = classifyExisting({ exists: true, meta: false })
    expect(r.action).toBe('refuse')
    expect(r.reason).toMatch(/not installed by/)
    expect(classifyExisting({ exists: true, meta: false }, { force: true }).action).toBe('install')
  })

  it('provenance is only trusted when every field the installer writes is present', () => {
    // A meta file that lost a field is a half-written install, not evidence of a previous one.
    expect(provenanceMismatch({ version: '1', commit: 'c', target: 't', builtAt: 'b', sha256: 's' })).toBeNull()
    expect(provenanceMismatch({ version: '1', commit: 'c' })).toMatch(/target/)
    expect(provenanceMismatch(null)).toMatch(/meta/)
  })
})

describe('parseBuilt tolerates the runtime shapes', () => {
  it('reads key=value pairs from the CLI line', () => {
    expect(parseBuilt('saip build: commit=abc1234 target=bun-linux-x64')).toEqual({
      commit: 'abc1234', target: 'bun-linux-x64',
    })
    expect(parseBuilt('saip build: commit=unknown-commit target=unknown-target')).toMatchObject({ commit: 'unknown-commit' })
  })
})

const bunReady = (() => {
  const r = spawnSync('npx', ['--yes', 'bun@1.4.3', '--version'], { encoding: 'utf8', timeout: 120_000 })
  return r.status === 0
})()

describe.skipIf(!bunReady)('install:dev end to end — the installed artifact runs (#119)', () => {
  it('builds, installs, and executes into a temporary bindir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'saip-dev-'))
    const r = spawnSync(process.execPath, [join(repoRoot, 'cli/scripts/install-dev.mjs')], {
      encoding: 'utf8', cwd: repoRoot, timeout: 600_000,
      env: { ...process.env, SAIP_DEV_BINDIR: dir },
    })
    expect(r.stderr?.slice(0, 400)).toBe('')
    expect(r.status).toBe(0)

    const installed = join(dir, 'saip-dev')
    expect(existsSync(installed)).toBe(true)
    expect(statSync(installed).mode & 0o111).toBeTruthy()

    // The claim the script makes must be observable: run the installed thing, ask it what it is.
    const v = spawnSync(installed, ['--version'], { encoding: 'utf8', timeout: 60_000 })
    expect(v.stdout.trim()).toBe(manifestVersion)

    const b = spawnSync(installed, ['--built'], { encoding: 'utf8', timeout: 60_000 })
    expect(b.stdout).toMatch(/commit=/)
    expect(parseBuilt(b.stdout).target).toMatch(/bun-/)

    const meta = JSON.parse(readFileSync(metaPath(dir), 'utf8'))
    expect(meta.version).toBe(manifestVersion)
    const digest = createHash('sha256').update(readFileSync(installed)).digest('hex')
    expect(digest).toBe(meta.sha256)
  }, 600_000)

  it('refuses to overwrite a hand-made saip-dev without --force', () => {
    const dir = mkdtempSync(join(tmpdir(), 'saip-dev-refuse-'))
    const target = join(dir, 'saip-dev')
    writeFileSync(target, '#!/bin/sh\necho not mine\n', { mode: 0o755 })
    chmodSync(target, 0o755)
    const r = spawnSync(process.execPath, [join(repoRoot, 'cli/scripts/install-dev.mjs')], {
      encoding: 'utf8', cwd: repoRoot, timeout: 600_000,
      env: { ...process.env, SAIP_DEV_BINDIR: dir },
    })
    expect(r.status).not.toBe(0)
    expect((r.stderr || r.stdout)).toMatch(/refus/)
    expect(readFileSync(target, 'utf8')).toContain('not mine')
  }, 600_000)
})

describe.skipIf(bunReady)('install:dev is NOT silently skipped when Bun is unavailable', () => {
  it('reports the skipped rung rather than a green suite', () => {
    expect(bunReady, 'Bun could not be fetched, so the end-to-end install was never executed').toBe(false)
  })
})
