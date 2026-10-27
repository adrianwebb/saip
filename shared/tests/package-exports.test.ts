/**
 * Every declared subpath export must resolve to a built file (#187).
 *
 * `@saip/shared`'s `package.json` declared twelve subpath exports; five pointed at files that exist in
 * neither `src` nor `dist` — `config-schema`, `r2-client`, `hf-client`, `adapter-manifest`,
 * `user-manifest`. The package README imported two of them in example code, and
 * `explanation/cordis-plugin-model.mdx` named the R2 client as the mechanism that stops the CLI and the
 * gateways disagreeing. Nothing failed: the docs build checks that pages render and internal links
 * resolve — the docs referring to themselves — and a manifest entry has no link to check, exactly the
 * gap #162 describes for flag tables, one surface over.
 *
 * So this is the check with a failing state. It reads the manifest as Node reads it and requires each
 * target to exist on disk after the build, which is also what makes the guard run in CI: `pnpm -r test`
 * runs after `pnpm -r build`.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const pkgDir = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
  exports?: Record<string, string>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const entries = Object.entries(pkg.exports ?? {})

describe('every declared subpath export resolves (#187)', () => {
  it('the manifest declares exports at all — a check that reads nothing is not a check', () => {
    expect(entries.length, 'no exports in shared/package.json').toBeGreaterThan(5)
  })

  it.each(entries)('%s -> %s', (specifier, target) => {
    // "./dist/x.js" for a package whose build emits into dist: the built file is what consumers get.
    const rel = target.replace(/^\.\//, '')
    expect(existsSync(join(pkgDir, rel)),
      `exports["${specifier}"] points at ${target}, which does not exist — build it or remove the entry (see #187)`)
      .toBe(true)
  })

  it('the built output is not shipping a specifier that resolves to nothing', () => {
    // Catches the subtler variant: an export that resolves through the directory but not to a module
    // Node could load (e.g. a stray .d.ts with no .js, or a path escaping the package).
    for (const [specifier, target] of entries) {
      expect(target, `${specifier} must target a file inside the package`).toMatch(/^\.\//)
      expect(target, `${specifier} must resolve to a built module`).toMatch(/^\.\/dist\/[\w./-]+\.js$/)
      expect(existsSync(join(pkgDir, target.replace(/^\.\//, '').replace(/\.js$/, '.d.ts'))) ||
             existsSync(join(pkgDir, target.replace(/^\.\//, ''))),
      `${specifier} has no loadable output at ${target}`).toBe(true)
    }
  })
})

/**
 * The other half of the same claim: `@aws-sdk/client-s3` was a declared dependency of this package with
 * ZERO imports anywhere in the repo (`grep -rn "@aws-sdk" cli shared inference training` → nothing).
 * A dependency is a supply-chain surface and an install cost; the issue it belongs to (#63, the R2
 * client) has to earn it back in the same change that uses it.
 */
describe('dependencies are used (#187)', () => {
  it('no declared runtime dependency is referenced by nothing in the built output', () => {
    const deps = Object.keys(pkg.dependencies ?? {})
    const unused: string[] = []
    for (const dep of deps) {
      // Check the built JS rather than the source: the artifact is what proves a dependency is live.
      const hit = scanFor(join(pkgDir, 'dist'), dep)
      if (!hit) unused.push(dep)
    }
    expect(unused, `unused runtime dependency(ies) declared by @saip/shared: ${unused.join(', ')}`).toEqual([])
  })
})

/** Cheap recursive grep for a literal module name across built files. */
function scanFor(dir: string, needle: string): boolean {
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return false }
  for (const n of names) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) { if (scanFor(p, needle)) return true; continue }
    if (!/\.(js|cjs|mjs)$/.test(n)) continue
    if (readFileSync(p, 'utf8').includes(needle)) return true
  }
  return false
}
