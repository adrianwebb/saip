/**
 * Shared build facts (#119) — imported by `build-binaries.mjs` (release) and `install-dev.mjs` (dev).
 *
 * Why a module rather than a `main` guard: #101 deleted entry detection from the CLI precisely because
 * a compiled binary cannot resolve its own path, and the same reflex here would just move the problem.
 * Two files with no shared facts beat one file asking "am I the one being run?".
 *
 * The target list is the single source of truth for which platforms exist. Restating it is how a
 * release quietly stops publishing one architecture: `--target=x` vs `--target x` already produced an
 * artifact named `saip---target=linux-arm64` once (#71), and a duplicated table would fail silently
 * instead of loudly.
 */
import { execFileSync } from 'node:child_process'

/** Runs git in `cwd` and trims, for `gitInfo`. */
export const gitRun = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

export const ALL_TARGETS = ['bun-linux-x64', 'bun-linux-arm64', 'bun-darwin-x64', 'bun-darwin-arm64', 'bun-windows-x64']

/** Provenance placeholders: the shipped defaults, and the strings the installer replaces. */
export const PLACEHOLDERS = { commit: 'unknown-commit', target: 'unknown-target', date: 'unknown-date' }

const HOST_MAP = {
  'x64-linux': 'bun-linux-x64',
  'arm64-linux': 'bun-linux-arm64',
  'x64-darwin': 'bun-darwin-x64',
  'arm64-darwin': 'bun-darwin-arm64',
  'x64-win32': 'bun-windows-x64',
}

export function hostTarget(platform = process.platform, arch = process.arch) {
  const key = `${arch}-${platform}`
  const target = HOST_MAP[key]
  if (!target) throw new Error(`no Bun target for ${key}; pass --target explicitly`)
  return target
}

export function artifactName(target) {
  if (!ALL_TARGETS.includes(target)) throw new Error(`unknown Bun target "${target}"`)
  return `saip-${target.replace('bun-', '')}${target.includes('windows') ? '.exe' : ''}`
}

/**
 * The npm-runner executable for this platform (#122).
 *
 * `execFileSync('npx', …)` fails on Windows with `spawnSync npx ENOENT`: the real file there is
 * `npx.cmd`, and Node does not try batch extensions unless the spawn goes through a shell. Resolved in
 * one place because both build scripts (release and dev-install) invoke it, and a second copy would be
 * fixed on Linux and left broken on Windows — which is precisely what happened here.
 *
 * Naming the executable is enough for a direct spawn. Deliberately NOT `shell: true`, because that
 * would put the burden of quoting on every argument handed to Bun.
 */
// The bare shim name: on Windows `runBun` invokes it through `cmd.exe /c`, which resolves `npx.cmd`
// itself — passing the `.cmd` name straight to `execFileSync` is what `EINVAL` refused (#122).
export const NPX = 'npx'
/** Marker so `runBun` can tell a Windows shell-spawn of the shim from a direct POSIX spawn. */
export const NPX_WINDOWS_SPAWN = Symbol('npx-windows-shell-spawn')

/**
 * The name an installed dev binary must have to be executable here (#122): Windows will not run
 * `saip-dev` without `.exe`, so the installer must name it per platform rather than assume one string.
 */
export const devBinaryName = (platform = process.platform) => (platform === 'win32' ? 'saip-dev.exe' : 'saip-dev')

/**
 * Which commit this build came from (#125). Lives here because the release path needs it too — the
 * provenance used to be computed only by the dev installer, which is why release binaries reported
 * `unknown-commit` while dev builds knew their own history.
 *
 * Returns placeholders on failure (a tarball without `.git`, a shallow clone) rather than throwing: an
 * unattributable build is still a valid build, and "unknown" is honest where a guessed sha would not be.
 */
export function gitInfo(cwd, run = (args) => gitRun(args, cwd)) {
  let commit = PLACEHOLDERS.commit
  let dirty = false
  try {
    commit = run(['rev-parse', '--short', 'HEAD']) || PLACEHOLDERS.commit
    dirty = run(['status', '--porcelain']).length > 0
  } catch { /* no git: keep the placeholders */ }
  return { commit: `${commit}${dirty ? '-dirty' : ''}`, dirty }
}

/**
 * Run Bun through npx on every platform (#122).
 *
 * Two facts collide: on Windows the npm shim is `npx.cmd`, and since CVE-2024-27980 Node refuses to
 * spawn `.cmd`/`.bat` at all unless a shell is used — so `execFileSync('npx.cmd', …)` fails with
 * `EINVAL`, exactly as CI showed twice (first `ENOENT` naming the POSIX shim, then `EINVAL` once the
 * name was right). Node's own advisory permits `shell: true` when the input is sanitized, so the
 * safety lives here: every argument is validated before the command line is assembled, and anything
 * that is not a plain token is refused rather than quoted-and-hoped.
 *
 * This is a build script whose arguments are all generated in this repo — a pinned package specifier,
 * a target from `ALL_TARGETS`, a fixed entry path, and one output path — which is what makes a
 * allowlist the right shape. User-supplied values never reach it.
 */
const SAFE_ARG = /^[\w.@:=/+\\-]+$/

export function bunCommandLine(cmd, args) {
  const parts = [cmd, ...args]
  for (const part of parts) {
    if (typeof part !== 'string' || !SAFE_ARG.test(part)) {
      throw new TypeError(`refusing to pass a non-allowlisted argument through a shell: ${JSON.stringify(part)}`)
    }
  }
  return parts.join(' ')
}

/** POSIX keeps the direct spawn (no shell needed for `npx`); Windows goes through the shell. */
export function runBun(cmd, args, opts = {}) {
  if (process.platform === 'win32') {
    return execFileSync('cmd.exe', ['/d', '/s', '/c', bunCommandLine(cmd, args)], { ...opts })
  }
  return execFileSync(cmd, args, opts)
}
