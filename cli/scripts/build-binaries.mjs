/**
 * Build distributable single-file binaries with Bun (#71, #122, #125).
 *
 * Bun is used only to BUILD; the project's package manager stays pnpm and the runtime for tests stays
 * Node. Bun is invoked through `npx` at a pinned version rather than added as a dependency, because
 * `pnpm add -D bun` did something worse than installing: pnpm wrote `devEngines.packageManager = "bun"`
 * into cli/package.json, declaring the wrong package manager for the project. A build tool should not be
 * able to change that by being installed.
 *
 * Targets default to this host. Cross-compilation is the reason for Bun: it emits every target from one
 * machine, which `node --experimental-sea-config` cannot. The trade-off is recorded so CI can enforce it:
 * a cross-compiled binary is NOT executed here, so `--verify` (on for the host, off for foreign targets)
 * is what keeps "built" from being presented as "works".
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_TARGETS, NPX, PLACEHOLDERS, artifactName, gitInfo, gitRun, hostTarget, runBun } from './build-lib.mjs'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUN = 'bun@1.4.3' // pinned: a compiler upgrade must be a deliberate change, not a floating one
const OUT_DIR = join(pkgRoot, 'dist', 'binaries')
/**
 * Throwaway copy of `src` used to inject build provenance (#125).
 *
 * Provenance was previously written into the **tracked** `src/version.ts`, compiled, then restored in a
 * `finally`. That raced the test suite — vitest runs files in parallel workers, and
 * `cli/tests/version.test.ts` asserts the placeholder text of that very file, so CI failed intermittently
 * (PR #124). It also risks committing a machine-specific constant after a crash between write and restore.
 * Compiling a copy removes the whole class: `cli/src/**` is never written by a build, so no concurrent
 * reader can observe a half-built state and no `git add -A` can capture instrumented source.
 */
const PROV_DIR = join(pkgRoot, '.build-provenance')
const ENTRY = 'src/bin.ts'

/**
 * A distributed binary is often the only copy of the application on a server, so the version it prints
 * has to be embedded, not read from a manifest that is not there. The literal in `src/version.ts` is
 * therefore authoritative at runtime — so the build refuses to produce an artifact whose two version
 * numbers disagree, rather than trusting a discipline that will eventually lapse.
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

/**
 * Copy `src` and stamp provenance into the copy. Returns the directory to compile from, which sits inside
 * the package so Bun still resolves `node_modules` (and therefore `@saip/shared`) by walking upward.
 */
function prepareProvenance(target, builtAt) {
  rmSync(PROV_DIR, { recursive: true, force: true })
  mkdirSync(join(PROV_DIR), { recursive: true })
  cpSync(join(pkgRoot, 'src'), join(PROV_DIR, 'src'), { recursive: true })

  const file = join(PROV_DIR, 'src', 'version.ts')
  const { commit } = gitInfo(pkgRoot, (args) => gitRun(args, pkgRoot))
  const contents = readFileSync(file, 'utf8')
    .replace(`SAIP_BUILD_COMMIT = '${PLACEHOLDERS.commit}'`, `SAIP_BUILD_COMMIT = '${commit}'`)
    .replace(`SAIP_BUILD_TARGET = '${PLACEHOLDERS.target}'`, `SAIP_BUILD_TARGET = '${target}'`)
    .replace(`SAIP_BUILD_DATE = '${PLACEHOLDERS.date}'`, `SAIP_BUILD_DATE = '${builtAt}'`)
  // The version constant must survive untouched, or the parity guarantee below stops meaning anything.
  if (!contents.includes(`SAIP_VERSION = '${version()}'`)) {
    throw new Error('[binaries] provenance substitution disturbed SAIP_VERSION')
  }
  writeFileSync(file, contents, 'utf8')
  return { dir: PROV_DIR, commit }
}

function build(target, { verify, provenance }) {
  const name = artifactName(target)
  const outfile = join(OUT_DIR, name)
  // `npx --yes bun@<pinned> build …`. An earlier version passed `exec` as the first argument
  // (`npx exec …`), which is not a bun invocation; with stdio inherited the failure was opaque, and the
  // verification below had never been reached — nearly reported as tested.
  const args = ['--yes', BUN, 'build', '--compile', `--target=${target}`, ENTRY, '--outfile', outfile]
  console.log(`[binaries] ${target} -> dist/binaries/${name}`)
  // Platform-correct invocation (#122): a direct spawn on POSIX, `cmd.exe /c` with validated
  // arguments on Windows, where Node refuses to spawn the `npx.cmd` shim at all.
  runBun(NPX, args, { cwd: provenance.dir, stdio: 'inherit' })
  const bytes = existsSync(outfile) ? readFileSync(outfile).byteLength : 0
  console.log(`[binaries]   ${bytes.toLocaleString()} bytes · commit ${provenance.commit}`)
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
// (`argv.indexOf('--target') + 1`) silently returned the flag itself when given `--target=x`, building a
// file named `saip---target=linux-arm64`. Only caught by running the exact command the workflow uses.
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

const builtAt = new Date().toISOString()
let built = []
try {
  // One provenance copy per run: Bun needs to resolve the tree for every target, and a copy per target
  // would let two targets disagree about the commit they came from.
  const provenance = prepareProvenance(targets[0], builtAt)
  built = targets.map((t) => build(t, { verify: t === host && !argv.includes('--no-verify'), provenance }))
} finally {
  rmSync(PROV_DIR, { recursive: true, force: true })
}

// Checksums: an operator downloading a binary onto a server has no other way to know it is the artifact
// CI produced.
const sums = built.map((b) => {
  const digest = createHash('sha256').update(readFileSync(join(OUT_DIR, b.name))).digest('hex')
  return `${digest}  ${b.name}`
}).join('\n') + '\n'
writeFileSync(join(OUT_DIR, 'SHA256SUMS'), sums, { mode: 0o644 })
console.log(`[binaries] ${built.length} artifact(s) + SHA256SUMS in ${OUT_DIR.replace(pkgRoot + '/', '')}`)
