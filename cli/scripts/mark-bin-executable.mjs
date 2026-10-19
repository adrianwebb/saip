import { mkdirSync, chmodSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/**
 * tsc emits the bin entry without an executable bit, and a non-executable shebang file cannot
 * be launched by name through a symlink or a package-manager shim. Fix it as part of the build
 * rather than hoping every installer papers over it.
 */
const bin = fileURLToPath(new URL('../dist/index.js', import.meta.url))
if (!existsSync(bin)) { console.error(`[cli] ${bin} missing — build before this step`); process.exit(1) }
chmodSync(bin, (statSync(bin).mode & 0o777) | 0o755)
