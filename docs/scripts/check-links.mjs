/**
 * Link checker for the SAIP docs site.
 *
 * Why this replaces `check-links.sh`: the shell version mapped every href onto the filesystem by
 * stripping the site base and asking "does this file exist". Astro writes `dist` WITHOUT the base, so
 * `/saip/tutorials/getting-started/` and the broken `/tutorials/getting-started/` both resolve to a real
 * file — the checker reported "853 links, all valid" while four homepage cards 404ed in production. It was
 * answering a question that cannot detect the bug.
 *
 * A link is a **URL** fact, so this checks URLs:
 *   1. every root-absolute internal href must begin with the configured base (the bug class, loudly);
 *   2. the resolved page must exist in the build output;
 *   3. fragments must name an id that exists on the target page — a link that lands on the right page but
 *      the wrong heading is half-broken and invisible to a file check;
 *   4. with --live, external URLs are requested for real, which is the only way to catch a base/path
 *      mistake after deployment.
 *
 * Usage: node scripts/check-links.mjs [distDir] [--base=/saip] [--live]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const positional = argv.filter((a) => !a.startsWith('--'))
const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', positional[0] ?? 'dist')
const BASE = (argv.find((a) => a.startsWith('--base=')) ?? '--base=/saip').split('=').slice(1).join('=')
const LIVE = argv.includes('--live')
// `--origin=https://adrianwebb.github.io` turns the internal-link check into a request against the
// DEPLOYED site. That is the only check that can see a base/path mistake of the kind #123 shipped: the
// build output contains the same files at the same paths either way, so an on-disk check passes while
// the server 404s. Opt-in because it runs after deployment, not during a build.
const ORIGIN = (argv.find((a) => a.startsWith('--origin=')) ?? '').split('=').slice(1).join('=')

if (!existsSync(DIST)) {
  console.error(`❌ build directory not found: ${DIST}\n   run 'pnpm --filter @saip/docs build' first`)
  process.exit(1)
}

const HTML_FILES = []
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p)
    else if (p.endsWith('.html')) HTML_FILES.push(p)
  }
}
walk(DIST)

/** URL of a built page, e.g. dist/tutorials/x/index.html → /saip/tutorials/x/ */
const urlOf = (file) => `${BASE}${file.slice(DIST.length).replace(/\\/g, '/').replace(/\/index\.html$/, '/').replace(/^\/[^/]+\.html$/, (m) => m.replace(/\.html$/, '/'))}`

const PAGE_URL = new Map()
for (const f of HTML_FILES) PAGE_URL.set(urlOf(f), f)

const idsOf = (file) => new Set([...readFileSync(file, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))
const IDS = new Map()
for (const f of HTML_FILES) IDS.set(f, idsOf(f))

const errors = []
let checked = 0

const record = (page, href, why) => errors.push({ page, href, why })

for (const file of HTML_FILES) {
  const pageUrl = urlOf(file)
  const html = readFileSync(file, 'utf8')
  const hrefs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1])

  for (const href of hrefs) {
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('data:')) continue

    if (/^https?:\/\//.test(href)) {
      // External: skipped unless --live. A docs build must not fail because a provider's site is down,
      // which is why this is opt-in rather than the default.
      if (LIVE) {
        try {
          const res = await fetch(href, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(12_000) })
          checked++
          if (!res.ok) record(pageUrl, href, `external HTTP ${res.status}`)
        } catch (e) {
          checked++
          record(pageUrl, href, `external request failed: ${e?.name ?? e}`)
        }
      }
      continue
    }

    const [pathPart, fragment] = href.split('#')
    if (href.startsWith('#')) {
      checked++
      if (fragment && !IDS.get(file).has(fragment)) record(pageUrl, href, `anchor #${fragment} not present on this page`)
      continue
    }
    if (!pathPart && fragment) {
      checked++
      if (!IDS.get(file).has(fragment)) record(pageUrl, href, `anchor #${fragment} not present on this page`)
      continue
    }
    if (!/^\.{0,2}\//.test(pathPart)) continue // bare relative, handled by resolution below

    checked++

    // Rule 1: the class that shipped. A root-absolute URL must carry the site base.
    if (pathPart.startsWith('/') && !pathPart.startsWith(`${BASE}/`) && pathPart !== BASE) {
      record(pageUrl, href, `root-absolute link omits the site base "${BASE}" → requests ${pathPart} at the domain root (404 on GitHub Pages)`)
      continue
    }

    // Resolve against the page URL using browser semantics.
    let resolved
    if (pathPart.startsWith('/')) resolved = pathPart
    else {
      let work = pageUrl.endsWith('/') ? pageUrl : `${dirname(pageUrl)}/`
      let rest = pathPart
      while (rest.startsWith('../')) { rest = rest.slice(3); work = `${dirname(work.replace(/\/$/, ''))}/` }
      while (rest.startsWith('./')) rest = rest.slice(2)
      resolved = `${work}${rest}`
    }

    // Assets (anything with a file extension) are checked as files; everything else as a page URL.
    // The earlier version appended a trailing slash unconditionally, so `/saip/favicon.svg` became
    // `favicon.svg/` and every asset looked broken — a checker that cries wolf is worse than none.
    const last = resolved.split('/').pop() ?? ''
    if (/\.[a-z0-9]+$/i.test(last)) {
      const asFile = join(DIST, resolved.slice(BASE.length))
      if (!existsSync(asFile)) record(pageUrl, href, `no asset at ${resolved}`)
      continue
    }

    if (!resolved.endsWith('/')) resolved = `${resolved}/`
    const target = PAGE_URL.get(resolved)
    if (!target) {
      record(pageUrl, href, `no page at ${resolved}`)
      continue
    }
    if (ORIGIN) {
      // Ask the real server for the real URL. A 200 on disk and a 404 from GitHub Pages is exactly
      // the #123 failure, and only this request distinguishes them.
      try {
        const res = await fetch(`${ORIGIN.replace(/\/$/, '')}${resolved}`, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(15_000) })
        if (!res.ok) record(pageUrl, href, `deployed ${resolved} returned HTTP ${res.status}`)
      } catch (e) {
        record(pageUrl, href, `deployed request failed for ${resolved}: ${e?.name ?? e}`)
      }
    }
    if (fragment && !IDS.get(target).has(fragment)) {
      record(pageUrl, href, `${resolved} exists but has no anchor #${fragment}`)
    }
  }
}

console.log(`Checked ${checked} links across ${HTML_FILES.length} pages (base: ${BASE}${LIVE ? ', live external probes ON' : ''}).`)
if (errors.length) {
  for (const e of errors) console.log(`❌ ${e.page}\n     → ${e.href}\n       ${e.why}`)
  console.error(`\n❌ ${errors.length} broken link(s).`)
  process.exit(1)
}
console.log('✅ All internal links valid.')
