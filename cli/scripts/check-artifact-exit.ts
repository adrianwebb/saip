/**
 * `check-artifact-exit.ts` — the #172 gate: the COMPILED binary must exit on its own after a prompted
 * command finishes reporting.
 *
 * Why this is a script and not only a vitest case: no Node-level test can represent this defect.
 * `unref()` releases the event loop under Node and does not under Bun, and the thing users run is the
 * Bun-compiled single file (`build-binaries.mjs`). A test that spawns `node dist/bin.js` was the old
 * "verified against the real artifact" claim, and the artifact was never in it — which is how #151's
 * class survived into a release. So this check runs the actual `dist/binaries/saip-<platform>-<arch>`,
 * in a real pty, and fails with the child's last output if it is still alive after the deadline.
 *
 * Run: `pnpm --filter @saip/cli build:bin && npx tsx cli/scripts/check-artifact-exit.ts`
 * Exit 0 = every case exited by itself. 1 = something hung. 2 = the artifact is missing.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PtyRun, isolatedEnv, type PtyResult } from '../tests/support/pty.js'

const BIN = join(import.meta.dirname, '..', 'dist', 'binaries', `saip-${process.platform}-${process.arch}`)
const DEADLINE_MS = Number(process.env.CHECK_ARTIFACT_DEADLINE_MS ?? 20_000)
const PASSPHRASE = 'artifact-exit-probe'

if (!existsSync(BIN)) {
  console.error(`REFUSING TO PROCEED: ${BIN} does not exist.\nBuild it first: pnpm --filter @saip/cli build:bin`)
  process.exit(2)
}

/** A workspace that cannot see this machine: every state path redirected, ambient `SAIP_*` dropped. */
function workspace(): NodeJS.ProcessEnv & { dir: string } {
  const env = isolatedEnv({})
  const keep = new Set(['SAIP_SECRETS_FILE', 'SAIP_ENV_FILE', 'SAIP_HOSTS_FILE', 'SAIP_CONFIG'])
  for (const key of Object.keys(env)) if (key.startsWith('SAIP_') && !keep.has(key)) delete env[key]
  delete env.SAIP_SECRETS_PASSPHRASE     // a preset passphrase would skip the prompting being checked
  writeFileSync(env.SAIP_ENV_FILE as string, 'SAIP_R2_BUCKET=probe-bucket\nSAIP_R2_ENDPOINT=https://probe.r2.cloudflarestorage.com\n')
  return env
}

/** What the child is being asked to do, and how to tell the run is over. */
interface Case {
  id: string
  args: string[]
  /** The line that means "the command has finished reporting". */
  done: RegExp
  /** Answer for any question that is not the passphrase. `undefined` means press Enter. */
  value?: string
  maxAnswers?: number
}

const cases: Case[] = [
  // Every catalog item gets an answer so the wizard FINISHES. The defect is the process refusing to
  // exit after a complete report, so a cancelled run would prove nothing.
  { id: 'config init completes, then exits', args: ['config', 'init'], done: /secrets →/, value: 'probe-value-1', maxAnswers: 24 },
  // The create-with-confirm path: choose + confirm + the value prompt, then the report.
  { id: 'config set (prompted, creates the store), then exits', args: ['config', 'set', 'SAIP_PROBE_ONE'], done: /stored SAIP_PROBE_ONE/, value: 'probe-value-2', maxAnswers: 8 },
]

// `config set` creates a store with lower-case prompts (`choose a passphrase`, `confirm passphrase`)
// while the wizard asks `SAIP secret store passphrase:`. Matching only the upper-cased names made this
// driver wait forever for a prompt it could not see — so the alternation lists both, and the loop below
// is bounded by the clock as well as by the answer count.
const PROMPT = /(?:(SAIP secret store passphrase|choose a passphrase|confirm passphrase|[A-Z][A-Z0-9_]{2,}):)\s*$/

function newestPrompt(text: string): string | null {
  const tail = text.replace(/\x1b\[[0-9;?]*[0-9a-zA-Z]/g, '').replace(/\r/g, '')
  const m = PROMPT.exec(tail.slice(-400))
  return m ? m[1] : null
}

async function drive(c: Case): Promise<PtyResult> {
  const env = workspace()
  const run = new PtyRun({ cmd: BIN, args: c.args, env, cols: 100, rows: 50 })
  let answered = 0
  let last = ''
  const driveUntil = Date.now() + 45_000
  // Bounded loop, driven by what is ACTUALLY on screen rather than by a remembered question list:
  // the wizard's items come from the catalog plus the user's config, so a hardcoded sequence drifts.
  while (answered < (c.maxAnswers ?? 16) && Date.now() < driveUntil) {
    if (c.done.test(run.output.replace(/\x1b\[[0-9;?]*[0-9a-zA-Z]/g, ''))) break
    const p = newestPrompt(run.output)
    if (p && p !== last) {
      last = p
      answered++
      const isPass = p.includes('passphrase')
      run.write(`${isPass ? PASSPHRASE : (c.value ?? '')}\r`)
      continue
    }
    await new Promise((r) => setTimeout(r, 120))
  }
  return run.finish(DEADLINE_MS)
}

let failed = 0
for (const c of cases) {
  const r: PtyResult = await drive(c)
  const plain = r.raw.replace(/\x1b\[[0-9;?]*[0-9a-zA-Z]/g, '').replace(/\r/g, '')
  const reported = c.done.test(plain)
  if (r.hung || r.code === null) {
    failed++
    const tail = plain.split('\n').filter(Boolean).slice(-2).join(' / ').slice(0, 130)
    console.error(`FAIL ${c.id}: compiled binary never exited (deadline=${DEADLINE_MS}ms hung=${r.hung} code=${String(r.code)} signal=${String(r.signal)} reported=${reported}). Last output: ${tail}`)
  } else if (!reported) {
    failed++
    console.error(`FAIL ${c.id}: exited code=${r.code} but never printed its completion line — the driver did not reach the end state, so this run proves nothing.`)
  } else {
    console.log(`PASS ${c.id}: exited code=${r.code} after ${r.elapsedMs}ms, completion line printed`)
  }
}

if (failed) {
  console.error(`\n#172: ${failed} case(s) failed against ${BIN}.`)
  console.error('A prompted command that reports and then refuses to exit leaves the user staring at a')
  console.error('frozen terminal. The tty handle must be RELEASED (destroyed) when the command ends:')
  console.error('measured, once any listener has been attached to a tty stream, unref() drains the loop')
  console.error('under Node and does NOT under Bun — and Bun is what compiles this artifact.')
  process.exit(1)
}
console.log('\nAll cases exited on their own.')
