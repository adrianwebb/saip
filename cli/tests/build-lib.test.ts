/**
 * The shared build table (#119). Extracted so `build-binaries.mjs` and `install-dev.mjs` cannot drift
 * apart about what a target is called — the same reason `--target=x` vs `--target x` produced a garbage
 * artifact name once already (#71).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_TARGETS, gitInfo, hostTarget, artifactName, PLACEHOLDERS } from '../scripts/build-lib.mjs'

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

describe('builds never write tracked source (#125)', () => {
  // The race that broke CI on PR #124: the dev installer substituted provenance into
  // `src/version.ts`, compiled, then restored it — while vitest ran `version.test.ts` in a parallel
  // worker reading that same file. A test asserting on a file another test edits is not a flake to
  // retry, it is a design fault. The fix is a throwaway copy; this forbids the pattern coming back.
  const scripts = ['build-binaries.mjs', 'install-dev.mjs']

  for (const file of scripts) {
    it(`${file} does not write into src/`, () => {
      const src = readFileSync(join(root, 'cli/scripts', file), 'utf8')
      expect(src).not.toMatch(/writeFileSync\([^)]*['"`]src['"`]/)
      expect(src).not.toMatch(/versionFile/)
      // It may read the tracked file (the parity guard does), just not mutate it.
      expect(src).not.toMatch(/rmSync\([^)]*['"`]src['"`]/)
    })
  }

  it('provenance is injected into a gitignored copy instead', () => {
    const src = readFileSync(join(root, 'cli/scripts/build-binaries.mjs'), 'utf8')
    expect(src).toMatch(/\.build-provenance/)
    expect(src).toMatch(/cpSync\(/)
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8')
    expect(ignore).toMatch(/cli\/\.build-provenance\//)
  })

  it('gitInfo actually consults git by default (a stub default made every build claim unknown)', () => {
    const src = readFileSync(join(root, 'cli/scripts/build-lib.mjs'), 'utf8')
    expect(src).toMatch(/export function gitInfo\(cwd, run = \(args\) => gitRun\(args, cwd\)\)/)
    const info = gitInfo(resolve(join(root, 'cli')))
    expect(info.commit).toMatch(/^[0-9a-f]{7,}(-dirty)?$/)
  })
})

describe('bun invocation is safe on Windows (#122)', () => {
  it('assembles a shell command line only from allowlisted tokens', async () => {
    const { bunCommandLine } = await import('../scripts/build-lib.mjs')
    expect(bunCommandLine('npx', ['--yes', 'bun@1.4.3', 'build', '--compile', '--target=bun-windows-x64', 'src/bin.ts']))
      .toBe('npx --yes bun@1.4.3 build --compile --target=bun-windows-x64 src/bin.ts')
  })

  it('refuses anything that could be shell metacharacters rather than quoting and hoping', async () => {
    const { bunCommandLine } = await import('../scripts/build-lib.mjs')
    for (const bad of ['a;rm -rf', '$(id)', '`id`', 'a|b', 'a&&b', 'with space', '']) {
      expect(() => bunCommandLine('npx', [bad]), bad).toThrow(/allowlisted/)
    }
    // A space would split the argument once the shell sees it, so it is rejected rather than quoted
    // and hoped over. Windows path separators, by contrast, must PASS — the earlier version of this
    // allowlist omitted `\` and would have refused every real output path on that platform.
    expect(() => bunCommandLine('npx', ['--outfile', 'C:\\Program Files\\x.exe'])).toThrow(/allowlisted/)
    expect(() => bunCommandLine('npx', ['--outfile', 'D:\\a\\saip\\saip\\cli\\dist\\binaries\\saip-windows-x64.exe'])).not.toThrow()
    expect(bunCommandLine('npx', ['--target=bun-windows-x64', 'src/bin.ts'])).toBe('npx --target=bun-windows-x64 src/bin.ts')
  })

  it('the npx name carries no .cmd: Windows resolves it through cmd.exe, POSIX spawns directly', async () => {
    const { NPX } = await import('../scripts/build-lib.mjs')
    // Passing 'npx.cmd' to execFileSync is what produced EINVAL after CVE-2024-27980; the shim name is
    // resolved by `cmd.exe /c` instead.
    expect(NPX).toBe('npx')
  })
})
