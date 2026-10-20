/**
 * The decisions `install-dev.mjs` makes, isolated so they can be asserted without building anything
 * (#119). Keeping them out of the script file is also what lets the script stay unguarded: there is no
 * "am I main?" question when the logic is importable and the executable is a thin composition of it.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** Every field the installer writes. A meta file missing one is a half-finished install, not proof. */
export const META_FIELDS = ['version', 'commit', 'target', 'builtAt', 'sha256']

export function binDir(env = process.env, homedir = process.env.HOME ?? '') {
  return env.SAIP_DEV_BINDIR || join(homedir, '.local', 'bin')
}

export const metaPath = (dir) => join(dir, 'saip-dev.meta.json')

/** True when a complete provenance file from a previous install sits next to the binary. */
export function readsInstalled(dir) {
  const p = metaPath(dir)
  if (!existsSync(p)) return false
  try { return provenanceMismatch(JSON.parse(readFileSync(p, 'utf8'))) === null } catch { return false }
}

/**
 * What we may do about whatever is already at the destination.
 *
 * Ours (a complete meta file) is replaced freely. Anything else — a hand-made script, a symlink to
 * another build, a file that merely shares the name — is refused until `--force`, because the whole
 * point of `saip-dev` is that you know what it is, and silently replacing an artifact somebody chose
 * is how a machine ends up with three meanings for one path.
 */
export function classifyExisting({ exists, meta }, { force = false } = {}) {
  if (!exists) return { action: 'install' }
  if (meta) return { action: 'install' }
  if (force) return { action: 'install', overwrote: true }
  return {
    action: 'refuse',
    reason: 'refusing to overwrite a saip-dev that was not installed by this script (no matching provenance file). '
      + 'Remove it yourself, or pass --force if you are sure it is yours to replace.',
  }
}

/** Null when the provenance is complete; otherwise a message naming what is missing. */
export function provenanceMismatch(meta) {
  if (!meta || typeof meta !== 'object') return 'no saip-dev.meta.json provenance file'
  const missing = META_FIELDS.filter((f) => typeof meta[f] !== 'string' || meta[f] === '')
  if (missing.length) return `provenance file is missing ${missing.join(', ')}`
  return null
}

/** `saip --built` prints `commit=… target=… …`; parse it so the install can verify what it installed. */
export function parseBuilt(text) {
  const out = {}
  for (const m of String(text).matchAll(/(\w+)=([^\s]+)/g)) out[m[1]] = m[2]
  return out
}
