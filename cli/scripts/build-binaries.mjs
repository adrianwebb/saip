/**
 * Build distributable single-file binaries with Bun (#71).
 *
 * Bun is used only to BUILD; the project's package manager stays pnpm and the runtime for tests
 * stays Node. Bun is invoked through `npx` at a pinned version rather than added as a dependency,
 * because `pnpm add -D bun` was tried first and did something worse than installing: pnpm wrote
 * `devEngines.packageManager = "bun"` into cli/package.json, declaring the wrong package manager for
 * the project. A build tool should not be able to change that by being installed.
 *
 * Targets default to this host only. Cross-compilation is the reason for Bun: it emits every target
 * from one machine, which `node --experimental-sea-config` cannot do. The trade-off, recorded so CI
 * can enforce it: a cross-compiled binary was NOT executed, so `--verify` (default on for host, off
 * for foreign targets) is what keeps "built" from being presented as "works".
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUN = 'bun@1.4.3' // pinned: a compiler upgrade must be a deliberate change, not a floating one
const OUT_DIR = join(pkgRoot, 'dist', 'binaries')
const ENTRY = 'src/bin.ts'

// os-arch, matching `bun build --target`.
const ALL_TARGETS = ['bun-linux-x64', 'bun-linux-arm64', 'bun-darwin-x64', 'bun-darwin-arm64', 'bun-windows-x64']

function hostTarget() {
  const map = { 'x64-linux': 'bun-linux-x64', 'arm64-linux': 'bun-linux-arm64', 'x64-darwin': 'bun-darwin-x64', 'arm64-darwin': 'bun-darwin-arm64', 'x64-win32': 'bun-windows-x64' }
  const key = `${process.arch}-${process.platform}`
  const t = map[key]
  if (!t) throw new Error(`no Bun target for ${key}; pass --target explicitly`)
  return t
}

/**
 * A distributed binary is often the only copy of the application on a server, so the version it
 * prints has to be embedded, not read from a manifest that is not there. That makes the literal in
 * src/version.ts authoritative at runtime — so the build refuses to produce an artifact whose two
 * version numbers disagree, rather than trusting a discipline that will eventually lapse.
 */
function version() {
  const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version
  const source = readFileSync(join(pkgRoot, 'src', 'version.ts'), 'utf8').match(/SAIP_VERSION = '([^']+)'/)?.[1]
  if (!source) throw new Error('[binaries] src/version.ts has no SAIP_VERSION constant')
  if (source !== manifest) {
    throw new Error(`[binaries] refusing to build: src/version.ts says ${source} but package.json says ${manifest}`)
  }
  return manifest
}

function build(target, { verify }) {
  const name = `saip-${target.replace('bun-', '')}${target.includes('windows') ? '.exe' : ''}`
  const outfile = join(OUT_DIR, name)
  // `npx --yes bun@<pinned> build …` — an earlier version passed `exec` as the first argument,
  // turning it into `npx exec …`, which is not a bun invocation. The failure was opaque ("stdout:
  // null") because execFileSync stdio was inherit, so the guard below had never been reached and I
  // nearly reported it as tested.
  const args = ['--yes', BUN, 'build', '--compile', `--target=${target}`, ENTRY, '--outfile', outfile]
  console.log(`[binaries] ${target} -> dist/binaries/${name}`)
  execFileSync('npx', args, { cwd: pkgRoot, stdio: 'inherit' })
  const bytes = existsSync(outfile) ? readFileSync(outfile).byteLength : 0
  console.log(`[binaries]   ${bytes.toLocaleString()} bytes`)
  if (verify) {
    // Only the host target can be executed here; anything else is an unverified artifact.
    const out = execFileSync(outfile, ['--version'], { encoding: 'utf8' }).trim()
    if (out !== version()) throw new Error(`[binaries] ${target} reported "${out}", expected ${version()}`)
    console.log(`[binaries]   executed: --version -> ${out}`)
  } else {
    console.log(`[binaries]   NOT executed (foreign architecture) — do not describe this artifact as tested`)
  }
  return { name, target, bytes }
}

const argv = process.argv.slice(2)
const all = argv.includes('--all')
// Accept both `--target x` and `--target=x`. CI passes the `=` form, and the previous lookup
// (`argv.indexOf('--target') + 1`) silently returned the flag itself when given `--target=x`,
// which built a file named `saip---target=linux-arm64`. Only caught by running the exact command
// the workflow uses — see .github/workflows/binaries.yml.
const flagValue = (name) => {
  const inline = argv.find((a) => a.startsWith(`--${name}=`))
  if (inline) return inline.slice(inline.indexOf('=') + 1)
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const explicit = flagValue('target')
const targets = all ? ALL_TARGETS : [explicit || hostTarget()]
const host = hostTarget()
mkdirSync(OUT_DIR, { recursive: true })
if (argv.includes('--clean')) rmSync(OUT_DIR, { recursive: true, force: true })

const built = targets.map((t) => build(t, { verify: t === host && !argv.includes('--no-verify') }))

// Checksums: an operator downloading a binary onto a server has no other way to know it is the
// artifact CI produced.
const sums = built.map((b) => {
  const digest = createHash('sha256').update(readFileSync(join(OUT_DIR, b.name))).digest('hex')
  return `${digest}  ${b.name}`
}).join('\n') + '\n'
writeFileSync(join(OUT_DIR, 'SHA256SUMS'), sums, { mode: 0o644 })
console.log(`[binaries] ${built.length} artifact(s) + SHA256SUMS in ${OUT_DIR.replace(pkgRoot + '/', '')}`)
