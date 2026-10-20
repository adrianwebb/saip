/**
 * The shared build table (#119). Extracted so `build-binaries.mjs` and `install-dev.mjs` cannot drift
 * apart about what a target is called — the same reason `--target=x` vs `--target x` produced a garbage
 * artifact name once already (#71).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_TARGETS, hostTarget, artifactName, PLACEHOLDERS } from '../scripts/build-lib.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))

describe('target table is one source of truth (#119)', () => {
  it('declares the five platforms the release publishes', () => {
    expect([...ALL_TARGETS].sort()).toEqual([
      'bun-darwin-arm64', 'bun-darwin-x64', 'bun-linux-arm64', 'bun-linux-x64', 'bun-windows-x64',
    ].sort())
  })

  it('host detection returns one of the declared targets', () => {
    expect(ALL_TARGETS).toContain(hostTarget())
  })

  it('names artifacts consistently, with .exe only on Windows', () => {
    expect(artifactName('bun-linux-x64')).toBe('saip-linux-x64')
    expect(artifactName('bun-windows-x64')).toBe('saip-windows-x64.exe')
    expect(ALL_TARGETS.map(artifactName).filter((n) => n.endsWith('.exe'))).toHaveLength(1)
  })

  it('the two build scripts import the table instead of restating it', () => {
    // Structural guard against the drift class: a second copy of this list is how a release quietly
    // stops publishing one architecture.
    const binaries = readFileSync(join(root, 'cli/scripts/build-binaries.mjs'), 'utf8')
    const install = readFileSync(join(root, 'cli/scripts/install-dev.mjs'), 'utf8')
    expect(binaries).toMatch(/from '\.\/build-lib\.mjs'/)
    expect(install).toMatch(/from '\.\/build-lib\.mjs'/)
    for (const src of [binaries, install]) {
      expect(src).not.toMatch(/'bun-darwin-arm64',\s*'bun-darwin-x64'/)
    }
  })

  it('exposes the provenance placeholders both the source and the installer agree on', () => {
    expect(PLACEHOLDERS.commit).toBe('unknown-commit')
    expect(PLACEHOLDERS.target).toBe('unknown-target')
    // The CLI ships these as its defaults, so an un-instrumented build says "unknown" rather than
    // inventing a commit that looks real.
    const version = readFileSync(join(root, 'cli/src/version.ts'), 'utf8')
    expect(version).toContain(PLACEHOLDERS.commit)
    expect(version).toContain(PLACEHOLDERS.target)
  })
})
