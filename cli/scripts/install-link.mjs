import { chmodSync, mkdirSync, realpathSync, statSync, symlinkSync, unlinkSync, lstatSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

/**
 * Put `saip` on PATH by symlinking the built bin into a directory that is already on PATH.
 *
 * Two independent reasons this must be a SYMLINK and not a hard link or a copy:
 *   1. dependency resolution — a hard link is an ordinary file living in the bin directory,
 *      so Node walks up from there looking for node_modules and finds none (ERR_MODULE_NOT_FOUND
 *      for 'cordis'). A symlink keeps the module's home in the package directory.
 *   2. the entry guard — it resolves realpath, so argv[1] being a link path is now fine,
 *      which is precisely what made linking unusable before #70.
 * Detected by running the installer; the unit suite used symlinkSync directly and stayed green. Resolution order:
 *   1. `pnpm bin -g` when available — the package manager's own global bin dir,
 *   2. ~/.local/bin,
 *   3. ~/.local/share/pnpm/bin (pnpm's default location on this platform).
 * A directory is only chosen if it exists or can be created; nothing writes outside $HOME,
 * and no sudo path is attempted because that would be a surprise privilege escalation.
 */
const target = fileURLToPath(new URL('../dist/index.js', import.meta.url))
if (!existsSync(target)) { console.error('[cli] dist/index.js missing — run `pnpm --filter @saip/cli build` first'); process.exit(1) }
chmodSync(target, (statSync(target).mode & 0o777) | 0o755)

function candidates() {
  const out = []
  try { const p = execSync('pnpm bin -g', { encoding: 'utf8' }).trim(); if (p) out.push(p) } catch {}
  out.push(join(homedir(), '.local', 'bin'), join(homedir(), '.local', 'share', 'pnpm', 'bin'))
  return [...new Set(out)]
}

let dir
for (const c of candidates()) {
  try { mkdirSync(c, { recursive: true }); if (existsSync(c)) { dir = c; break } } catch {}
}
if (!dir) { console.error('[cli] no writable bin directory found; add one to PATH and re-run'); process.exit(1) }
const linkPath = join(dir, 'saip')
try { if (lstatSync(linkPath)) unlinkSync(linkPath) } catch { /* nothing there yet */ }
symlinkSync(target, linkPath)
console.log(`[cli] linked ${linkPath} -> ${target}`)
console.log(`[cli] if \`saip\` is not found, ensure ${dir} is on PATH`)
