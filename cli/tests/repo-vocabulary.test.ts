/**
 * No other project's vocabulary may live in this repository (#193).
 *
 * SAIP is its own product. The harness-plugin project SAIP is developed ALONGSIDE of contributed
 * language to this repository twice: as the whole content of the `local-llm` skill
 * (#188), as another repository's release runbook vendored into `github-ops` (#189), and as the
 * canonical example adapter name in six documentation pages and two training fixtures.
 *
 * Both previous checks were scoped to `.dsh/skills/**` — the directory where the last bug lived.
 * A check's scope is what it can see, so a scoped check's green result is not evidence about the
 * repository; it is evidence about the scope. This one scans every tracked file.
 *
 * The token list is assembled from fragments (`'dsh' + '-chapters'`) for one reason: a scanner
 * that contains the strings it hunts would need an exemption for itself, and an exemption that can
 * grow is how the next case hides. With fragments, the ONLY exempt file is the #188 skill guard,
 * which quotes the pre-fix skill verbatim so it can prove it still rejects it — and the exemption
 * list is asserted to be exactly that one path, so it cannot silently widen.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..', '..')

/**
 * Each token is stored split, so no line of this file contains a complete token — which is what
 * lets the exemption list stay at exactly one entry. Note the trap found the hard way: a fragment
 * can itself BE another token, and an explanatory comment that spells a token out loud defeats the
 * whole scheme — the first run of this file flagged its own prose. Pieces are therefore chosen to
 * be fragments of nothing else on the list.
 */
const FRAGMENTS: Array<{ parts: string[]; why: string }> = [
  { parts: ['dsh', '-chapters'], why: 'the sibling project, named as a product' },
  { parts: ['dsh', '-test'], why: "that project's container" },
  { parts: ['dsh', '-web'], why: "that project's container" },
  { parts: ['dsh', ' web'], why: "that project's CLI" },
  { parts: ['dev', '/install'], why: "that project's dev platform directory" },
  { parts: ['tree', 'seed'], why: 'the organisation that publishes that project' },
  { parts: ['mode', 'l-tape'], why: "that project's replay corpus concept" },
  { parts: ['corpu', 's:heal'], why: "that project's npm script" },
  { parts: ['corpu', 's:record'], why: "that project's npm script" },
  { parts: ['E2E', '_'], why: "that project's e2e env-var namespace" },
  { parts: ['PLAY', 'WRIGHT'], why: "that project's browser test runner" },
  { parts: ['ms-', 'play', 'wright'], why: "that project's browser cache path" },
  { parts: ['qwen3-4b', '-instruct'], why: "that project's served model alias" },
  { parts: ['qwen3-4b', '-systemone'], why: "that project's served model alias" },
  { parts: ['VLLM_G', 'PU_MEM'], why: "that project's compose variable" },
  { parts: ['VLLM_SER', 'VED_NAMES'], why: "that project's compose variable" },
  { parts: ['VLLM_MO', 'DEL_ID'], why: "that project's compose variable" },
  { parts: ['subagent-', 'driven-development'], why: 'a skill not installed here' },
  { parts: ['systematic-', 'debugging'], why: 'a skill not installed here' },
  { parts: ['executing-', 'plans'], why: 'a skill not installed here' },
  { parts: ['test-', 'driven-development'], why: 'a skill not installed here' },
  { parts: ['superpowers', ':'], why: 'a skill namespace that does not exist here' },
  { parts: ['affa', 'an-m'], why: 'an unrelated upstream owner' },
  { parts: ['ecc-', 'universal'], why: 'an unrelated upstream package' },
  { parts: ['ECC-', '031'], why: 'an unrelated upstream milestone' },
  { parts: ['open', 'code'], why: 'an unrelated upstream repository' },
  { parts: ['tree', 'dx'], why: 'an unrelated sibling project' },
]

export const FORBIDDEN: Array<{ token: string; why: string }> = FRAGMENTS.map(({ parts, why }) => ({
  token: parts.join(''),
  why,
}))

/** The single permitted holder of these strings, by exact path. */
const EXEMPT: readonly string[] = ['cli/tests/skill-provenance.test.ts']

interface Hit { file: string; line: number; token: string }

/** Tracked text files. Binary content is skipped by NUL sniffing, and the count is asserted so an
 *  empty file set can never report a pass. */
function trackedTextFiles(): string[] {
  const all = execFileSync('git', ['-C', repoRoot, 'ls-files'], { encoding: 'utf8' })
    .split('\n').filter(Boolean)
  return all.filter((f) => {
    if (EXEMPT.includes(f)) return false
    try {
      const buf = readFileSync(join(repoRoot, f))
      return !buf.includes(0)
    } catch { return false }
  })
}

function scan(files: string[]): Hit[] {
  const hits: Hit[] = []
  for (const f of files) {
    const text = readFileSync(join(repoRoot, f), 'utf8')
    text.split('\n').forEach((line, i) => {
      for (const { token } of FORBIDDEN) {
        if (line.toLowerCase().includes(token.toLowerCase())) hits.push({ file: f, line: i + 1, token })
      }
    })
  }
  return hits
}

describe('repository vocabulary — this project is SAIP, not another project (#193)', () => {
  const files = trackedTextFiles()

  it('scans a real file set, so it cannot pass vacuously', () => {
    expect(files.length, 'tracked text file count').toBeGreaterThan(200)
  })

  it('the token list is complete and the exemption is exactly one file', () => {
    expect(FORBIDDEN.length).toBe(27)
    expect(FORBIDDEN.every((x) => x.token.length > 3 && x.why.length > 0)).toBe(true)
    // The self-exemption trap: a scanner exempting itself, or a directory glob standing in for a
    // judgement, both hide the next case. This must stay one named path.
    expect(EXEMPT).toEqual(['cli/tests/skill-provenance.test.ts'])
    expect(files.includes('cli/tests/skill-provenance.test.ts'), 'the exempt file must be skipped').toBe(false)
  })

  it('assembling the fragments yields exactly the intended token set', () => {
    // A mistyped fragment would silently produce a token that matches nothing, and the scan would
    // pass on the very thing it was written to catch. Asserting the literals here would reintroduce
    // them, so the expectation is a digest of the joined set: any change to any fragment moves it.
    const digest = createHash('sha256').update(FORBIDDEN.map((x) => x.token).sort().join('\n')).digest('hex')
    expect(digest, 'FORBIDDEN assembled differently than audited').toBe('caabe063957b0fef38f56f4bf7bb8ca318ba101a55d384a26de4fbda91d09397')
    expect(FORBIDDEN.length).toBe(27)
    expect(FORBIDDEN.every((x) => x.token.trim().length > 3)).toBe(true)
  })

  it('no tracked file carries another project\'s vocabulary', () => {
    const hits = scan(files)
    const report = hits.slice(0, 40).map((h) => `${h.file}:${h.line}  ${h.token}`).join('\n')
    expect(hits, `${String(hits.length)} violation(s), first 40:\n${report}`).toEqual([])
  })
})
