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
export const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx'

/**
 * The name an installed dev binary must have to be executable here (#122): Windows will not run
 * `saip-dev` without `.exe`, so the installer must name it per platform rather than assume one string.
 */
export const devBinaryName = (platform = process.platform) => (platform === 'win32' ? 'saip-dev.exe' : 'saip-dev')
