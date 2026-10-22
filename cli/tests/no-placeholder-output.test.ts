/**
 * No shipped output may be a placeholder (#114).
 *
 * `saip status` printed `Mode: TODO (awake / asleep / down)` while CI stayed green, because the only
 * assertions on that command pinned the three lines that happened to be finished. The fix is not the
 * one command — it is a check over the whole **read-only** surface, so the next unfinished field is a
 * failing test at the level a user observes it, which is exactly what AGENTS.md demands and what was
 * missing here.
 *
 * Deliberately restricted to commands that only read state, and deliberately run as the assembled
 * program: the point is the bytes an operator sees, not what a module returns. `SAIP_DRY_RUN=1` keeps
 * docker interaction inert, and every path is isolated to a temp dir (#154's rule).
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const distBin = join(here, '..', 'dist', 'bin.js')
const built = existsSync(distBin)

// Read-only commands only: nothing here may change state, deploy, or prompt. `config init`,
// `awake`, `sleep`, `down`, `deploy` and `ssh generate` are excluded on purpose — each either mutates
// or needs a terminal, and a guard that has to fake a terminal stops guarding the real thing.
const READ_ONLY: Array<{ label: string; args: string[] }> = [
  { label: 'status', args: ['status'] },
  { label: 'status --json', args: ['status', '--json'] },
  { label: 'config list', args: ['config', 'list'] },
  { label: 'config list --json', args: ['config', 'list', '--json'] },
  { label: 'config help', args: ['config', 'help'] },
  { label: 'config doctor', args: ['config', 'doctor'] },
  { label: 'config doctor --json', args: ['config', 'doctor', '--json'] },
  { label: 'ssh list', args: ['ssh', 'list'] },
  { label: 'profiles --json', args: ['profiles', '--json'] },
  { label: '--version', args: ['--version'] },
]

function runIn(args: string[], dir: string): { code: number | null; out: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(dir, 'home'),
    SAIP_CONFIG: join(dir, 'saip.yaml'),
    SAIP_ENV_FILE: join(dir, '.env'),
    SAIP_SECRETS_FILE: join(dir, 'secrets.enc.json'),
    SAIP_HOSTS_FILE: join(dir, 'hosts.yaml'),
    SAIP_DRY_RUN: '1',
  }
  delete env.SAIP_HOST
  try {
    return { code: 0, out: execFileSync(process.execPath, [distBin, ...args], { encoding: 'utf8', env, cwd: dir }) }
  } catch (e: any) {
    // A non-zero exit is legitimate for some of these (no GPU, empty store); the assertion below is
    // about the TEXT, so capture whatever it printed rather than treating a refusal as a pass.
    return { code: e?.status ?? null, out: `${e?.stdout ?? ''}${e?.stderr ?? ''}` }
  }
}

describe('no CLI output line is a placeholder (#114)', () => {
  it.each(READ_ONLY)('$label contains no TODO in its output', async ({ args }) => {
    expect(built, 'run `pnpm --filter @saip/cli build` first — this guard checks the assembled program').toBe(true)
    const dir = mkdtempSync(join(tmpdir(), 'saip-noword-'))
    writeFileSync(join(dir, 'hosts.yaml'), 'hosts:\n  - name: default\n    kind: local\n    role: both\n')
    const r = runIn(args, dir)
    // Something was printed: an empty output would make the TODO check vacuously true, which is the
    // unfailable-test shape this repo has hit five times.
    expect(r.out.trim(), `${args.join(' ')} printed nothing, so the placeholder check proves nothing`).not.toBe('')
    const offenders = r.out.split('\n').map((l) => l.trim()).filter((l) => /\bTODO\b/.test(l))
    expect(offenders, `placeholder lines from \`saip ${args.join(' ')}\`: ${JSON.stringify(offenders)}`).toEqual([])
  })
})
