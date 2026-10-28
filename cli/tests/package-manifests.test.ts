/**
 * Every package's manifest entry points must resolve in the built output (#187).
 *
 * `shared/tests/package-exports.test.ts` (the maintainer's test for #187) covers `@saip/shared`'s
 * subpath exports — the package that had the bug. #188 and #189 both demonstrated what happens when a
 * check is scoped to the directory where the last defect lived: `cli`, `inference` and `training`
 * declare `main`/`types` that nothing asserts, so a manifest pointing at an artifact their build
 * stopped emitting would fail silently today, exactly as shared's phantom entries did.
 *
 * So this is the same claim, widened to the workspace. It lives with the other repo-wide checks in
 * `cli/tests` and runs under the existing `pnpm --filter @saip/cli test` CI step, after `pnpm -r build`.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')

interface Manifest { name: string; main?: string; types?: string; exports?: Record<string, string> | string }

const packages = execFileSync('git', ['-C', repoRoot, 'ls-files', '*package.json'], { encoding: 'utf8' })
  .split('\n').filter((f) => f && !f.includes('node_modules') && f !== 'package.json')
  .map((f) => ({ file: f, dir: dirname(f), pkg: JSON.parse(readFileSync(join(repoRoot, f), 'utf8')) as Manifest }))

/**
 * Packages that publish no JS entry point on purpose. `@saip/docs` is an Astro site — a deployable,
 * not an importable library — so declaring `main` would be the fiction. It is named individually
 * rather than excused by "has no exports field", because that inference is precisely how a package
 * whose build broke and stopped emitting an entry point would pass unnoticed.
 */
const NO_ENTRY_POINTS = ['@saip/docs']

/** Every target a manifest promises, with the specifier that named it. */
function targets(pkg: Manifest): Array<{ where: string; target: string }> {
  const out: Array<{ where: string; target: string }> = []
  if (pkg.main) out.push({ where: 'main', target: pkg.main })
  if (pkg.types) out.push({ where: 'types', target: pkg.types })
  const walk = (spec: string, v: unknown): void => {
    if (typeof v === 'string') { out.push({ where: `exports["${spec}"]`, target: v }); return }
    if (v && typeof v === 'object') for (const [k, sub] of Object.entries(v)) walk(k === '.' ? spec : `${spec}/${k}`, sub)
  }
  if (typeof pkg.exports === 'string') out.push({ where: 'exports', target: pkg.exports })
  else if (pkg.exports) for (const [spec, v] of Object.entries(pkg.exports)) walk(spec, v)
  return out
}

describe('package manifests resolve in the built output (#187)', () => {
  it('scans the real workspace, so an empty file set cannot report a pass', () => {
    expect(packages.length, 'no package.json files found').toBeGreaterThanOrEqual(4)
    expect(packages.map((p) => p.pkg.name)).toContain('@saip/shared')
  })

  it('the no-entry-point exemption is exactly the site package', () => {
    expect(NO_ENTRY_POINTS).toEqual(['@saip/docs'])
  })

  it.each(packages.map((p) => [p.pkg.name, p] as const))('%s promises only files that exist', (_name, p) => {
    const list = targets(p.pkg)
    if (list.length === 0) {
      expect(NO_ENTRY_POINTS, `${p.file} declares no entry points; if that is intended, name it in NO_ENTRY_POINTS`)
        .toContain(p.pkg.name)
      return
    }
    const missing = list
      .map(({ where, target }) => ({ where, target, ok: existsSync(resolve(join(repoRoot, p.dir), target.replace(/^\.\//, ''))) }))
      .filter((x) => !x.ok)
    expect(missing, `${p.file} declares targets with no built file behind them:\n`
      + missing.map((m) => `  ${m.where} -> ${m.target}`).join('\n')).toEqual([])
  })
})
