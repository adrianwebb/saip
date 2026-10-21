#!/usr/bin/env node
/**
 * `pnpm --filter @saip/cli install:dev` — build the host binary and install it as `saip-dev` (#119).
 *
 * Thin on purpose: every decision it makes lives in `install-dev-lib.mjs` where a test can assert it,
 * and the build itself is delegated to `build-binaries.mjs`, so the dev path inherits the release
 * path's guarantees (version parity refused, and the artifact executed before anyone calls it done).
 * There is no entry-detection guard here; #101 deleted that pattern, and a script that imports its
 * logic instead of guarding `main` never has to ask the question.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifactName, devBinaryName, hostTarget, PLACEHOLDERS } from './build-lib.mjs'
import { binDir, classifyExisting, metaPath, parseBuilt, provenanceMismatch, readsInstalled } from './install-dev-lib.mjs'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const versionFile = join(pkgRoot, 'src', 'version.ts')

const argv = process.argv.slice(2)
const force = argv.includes('--force')
const target = (() => {
  const inline = argv.find((a) => a.startsWith('--target='))
  const spaced = argv.indexOf('--target')
  return (inline && inline.split('=')[1]) || (spaced >= 0 ? argv[spaced + 1] : undefined) || hostTarget()
})()
const dir = binDir(process.env, process.env.HOME ?? '')
const installed = join(dir, devBinaryName())

function git(args) {
  try { return execFileSync('git', args, { cwd: pkgRoot, encoding: 'utf8' }).trim() } catch { return PLACEHOLDERS.commit }
}

const commit = git(['rev-parse', '--short', 'HEAD'])
const dirty = git(['status', '--porcelain']) !== PLACEHOLDERS.commit && git(['status', '--porcelain']).length > 0
const builtAt = new Date().toISOString()

const verdict = classifyExisting({ exists: existsSync(installed), meta: readsInstalled(dir) }, { force })
if (verdict.action === 'refuse') {
  process.stderr.write(`[install:dev] ${verdict.reason}\n`)
  process.exit(1)
}

mkdirSync(dir, { recursive: true })

/**
 * The compiled artifact must carry the commit it came from, and the only way to do that without a
 * runtime `.git` read (which would report the developer's checkout, not the build) is to substitute
 * these lines before compilation and restore them after. Reversibility is not optional: a crashed
 * install must not leave the working tree holding a machine-specific constant.
 */
const original = readFileSync(versionFile, 'utf8')
const substituted = original
  .replace(`SAIP_BUILD_COMMIT = '${PLACEHOLDERS.commit}'`, `SAIP_BUILD_COMMIT = '${commit}${dirty ? '-dirty' : ''}'`)
  .replace(`SAIP_BUILD_TARGET = '${PLACEHOLDERS.target}'`, `SAIP_BUILD_TARGET = '${target}'`)
  .replace(`SAIP_BUILD_DATE = '${PLACEHOLDERS.date}'`, `SAIP_BUILD_DATE = '${builtAt}'`)
if (substituted === original) {
  throw new Error('[install:dev] version.ts no longer carries the provenance placeholders — refusing to build an unattributable binary')
}

try {
  writeFileSync(versionFile, substituted, 'utf8')
  process.stdout.write(`[install:dev] building ${target} (commit ${commit}${dirty ? '-dirty' : ''})\n`)
  execFileSync(process.execPath, [join(pkgRoot, 'scripts', 'build-binaries.mjs'), `--target=${target}`], {
    cwd: pkgRoot, stdio: ['ignore', 'inherit', 'inherit'],
  })
} finally {
  writeFileSync(versionFile, original, 'utf8')
}

const artifact = join(pkgRoot, 'dist', 'binaries', artifactName(target))
if (!existsSync(artifact)) throw new Error(`[install:dev] expected artifact not found: ${artifact}`)
const bytes = readFileSync(artifact)
const sha256 = createHash('sha256').update(bytes).digest('hex')

// Copy to a sibling then rename, so a failure mid-write cannot leave a truncated executable at the path
// the user will type.
const staging = `${installed}.tmp-${process.pid}`
copyFileSync(artifact, staging)
chmodSync(staging, 0o755)
renameSync(staging, installed)

const manifestVersion = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version
const reported = execFileSync(installed, ['--version'], { encoding: 'utf8', timeout: 60_000 }).trim()
if (reported !== manifestVersion) {
  throw new Error(`[install:dev] installed binary reports "${reported}", expected ${manifestVersion}`)
}
const built = parseBuilt(execFileSync(installed, ['--built'], { encoding: 'utf8', timeout: 60_000 }))
if (!built.commit || !built.target) {
  throw new Error(`[install:dev] installed binary does not report provenance: ${JSON.stringify(built)}`)
}
// Exact mode, not a bit mask guessed at: 0755 legitimately carries group/other read+execute, and an
// earlier `mode & 0o007` check here rejected a correctly permissioned binary — a check that measured
// its own arithmetic rather than the artifact.
if ((statSync(installed).mode & 0o777) !== 0o755) {
  throw new Error(`[install:dev] installed binary mode is ${(statSync(installed).mode & 0o777).toString(8)}, expected 755`)
}

const meta = { version: manifestVersion, commit: `${commit}${dirty ? '-dirty' : ''}`, target, builtAt, sha256 }
const mismatch = provenanceMismatch(meta)
if (mismatch) throw new Error(`[install:dev] ${mismatch}`)
writeFileSync(metaPath(dir), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o644 })

const onPath = (process.env.PATH ?? '').split(':').includes(dir)
process.stdout.write(
  `[install:dev] ${installed}\n` +
  `[install:dev]   ${manifestVersion} · ${target} · commit ${meta.commit} · ${sha256.slice(0, 16)}…\n` +
  `[install:dev]   verified by executing it: --version -> ${reported}, --built -> commit=${built.commit} target=${built.target}\n` +
  (onPath
    ? '[install:dev] run `saip-dev --version` anywhere. `saip` (source build) is unchanged.\n'
    : `[install:dev] WARNING: ${dir} is not on PATH. Add it:\n  export PATH="${dir}:$PATH"\n`),
)
