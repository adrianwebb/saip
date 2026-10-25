/**
 * `saip config init` asks for the store passphrase EXACTLY ONCE (#169).
 *
 * Level: the assembled command, run as a program in a real pty — the level #110's acceptance run
 * found the defect at, and the level #76 requires because injected-collaborator tests cannot see
 * wiring. The existing wizard tests inject `io` and a scripted store, so none of them could ever
 * observe a second passphrase prompt: they never unlock anything.
 *
 * MEASURED order (from a real pty run against `dist/bin.js`, before this was fixed), which is the
 * opposite of intuitive and therefore recorded here rather than assumed:
 *   - the passphrase is NOT asked up front. The store does not exist yet, so `unlock()` has nothing
 *     to open; the ask comes from the FIRST SECRET WRITE, i.e. after `SAIP_R2_ACCESS_KEY_ID:` has
 *     been shown and answered.
 *   - the wizard's creation path asks once (`SAIP secret store passphrase:`), not the
 *     choose/confirm pair that `config set` uses — so `confirm passphrase` is absent here.
 *   - the DEFECT: after that write completed, the very next read re-derived the key and asked
 *     again. `SecretStore.persist()` seeds nothing into `kekCache` when it creates a store, so the
 *     cache was cold for the read that followed the creation.
 *   - the part the byte-offset evidence hides: the second prompt consumes the NEXT answer. A user
 *     typing their secret-access key answers the passphrase instead, every later question is
 *     shifted by one, and the item they meant to fill stays empty. So this file asserts the
 *     second write actually landed, not merely that a count looks reasonable.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PtyRun, isolatedEnv, type PtyResult } from './support/pty.js'
import { renderScreen } from './support/screen.js'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const distBin = join(repoRoot, 'cli/dist/bin.js')
const node = process.execPath

const PASSPHRASE = 'one-unlock-probe-pass'
/** Every occurrence of the store prompt, counted from the raw stream. */
const asks = (text: string): number => (text.match(/SAIP secret store passphrase:/g) ?? []).length

/**
 * A workspace that cannot see this shell.
 *
 * `isolatedEnv` redirects the state paths but inherits `process.env`, and the maintainer's shell
 * exports `SAIP_R2_BUCKET` — which is exactly how a first pass of #110's row 5 "failed" for a
 * reason that lived in the driver. So every `SAIP_*` except the four state paths is dropped.
 */
function wizardEnv(): NodeJS.ProcessEnv & { dir: string } {
  const env = isolatedEnv({})
  const keep = new Set(['SAIP_SECRETS_FILE', 'SAIP_ENV_FILE', 'SAIP_HOSTS_FILE', 'SAIP_CONFIG'])
  for (const key of Object.keys(env)) {
    if (key.startsWith('SAIP_') && !keep.has(key)) delete env[key]
  }
  // A preset passphrase would skip the prompt entirely and make this file unable to fail.
  delete env.SAIP_SECRETS_PASSPHRASE
  return env
}

describe('config init asks for the store passphrase once (#169)', () => {
  it('two secret writes, one passphrase prompt, in a real pty against the assembled command', async () => {
    const env = wizardEnv()
    const run = new PtyRun({ cmd: node, args: [distBin, 'config', 'init'], env, cols: 100, rows: 50 })
    // Every failing assertion below abandons a live child mid-wizard. `finish()` is what reaps it on
    // the success path, so the failure path needs the same cleanup or CI inherits a process holding a
    // terminal open — the hang class this repo has already been bitten by (#151).
    let done = false
    try {
    // Config-kind items first: writing them touches the env file, never the store, so they cannot
    // be responsible for a passphrase prompt — and typing them (rather than Enter) keeps this
    // independent of whatever the ambient shell exports.
    await expect(run.waitFor('SAIP_R2_BUCKET:', 25_000)).resolves.toBe(true)
    run.write('probe-bucket\r')
    await expect(run.waitFor('SAIP_R2_ENDPOINT:', 25_000)).resolves.toBe(true)
    run.write('https://account-id.r2.cloudflarestorage.com\r')

    // The first SECRET. Answering the question is what creates the store, so this is the one and
    // only place the passphrase may legitimately be asked.
    await expect(run.waitFor('SAIP_R2_ACCESS_KEY_ID:', 25_000)).resolves.toBe(true)
    run.write('AKIAIOSFODNN7EXAMPLE\r')
    await expect(run.waitFor('SAIP secret store passphrase:', 25_000)).resolves.toBe(true)
    expect(asks(run.output)).toBe(1)
    run.write(`${PASSPHRASE}\r`)

    // THE GATE. With the defect, the wizard asks for the passphrase again here, and the value typed
    // below is eaten by that prompt instead of filling the item.
    await expect(run.waitFor('SAIP_R2_SECRET_ACCESS_KEY:', 25_000)).resolves.toBe(true)
    expect(asks(run.output)).toBe(1)
    run.write('wJalrXUtnFEMI-KMD-spark-example\r')

    await expect(run.waitFor('SAIP_HF_TOKEN:', 25_000)).resolves.toBe(true)
    expect(asks(run.output)).toBe(1)

    // Cancel at a later question: what matters is that BOTH writes above really landed.
    run.write('\u0003')
    const r: PtyResult = await run.finish(25_000)
    done = true
    expect(r.code).toBe(130)
    expect(r.hung).toBe(false)

    const rows = renderScreen(r.raw, 50, 100).visible()
    // Assert on the VERBATIM stream, not the reconstructed screen. Measured, and it is the reason an
    // earlier draft of this failed against a correct product: `renderScreen` keeps the last 50 rows,
    // and the cards for the items AFTER the second write scroll the `stored …` line off the model.
    // The screen model is the right instrument for placement questions (is the prompt on its own
    // line?) and the wrong one for "did this line ever print".
    const plain = r.raw.replace(/\x1b\[[0-9;?]*[0-9a-zA-Z]/g, '').replace(/\r/g, '')
    // Not a count alone: the second write must have been STORED under the answer typed for it,
    // which is the observable difference between one unlock and a swallowed keystroke.
    expect(plain).toMatch(/stored SAIP_R2_ACCESS_KEY_ID \(\d+ chars\)/)
    expect(plain).toMatch(/stored SAIP_R2_SECRET_ACCESS_KEY \(\d+ chars\)/)
    expect(plain).not.toMatch(/still to fill \(\d+\):[^\n]*SAIP_R2_SECRET_ACCESS_KEY/)
    expect(asks(r.raw)).toBe(1)
    // And nothing about the cancel summary may claim a value was written that was not (#150).
    expect(plain).toMatch(/written now: \d value\(s\)/)
    expect(rows.length).toBeGreaterThan(0)

    // Proof on disk, in a SECOND process that never prompts: the wizard's own report is a claim, the
    // store is the fact. `config list` masks values but names them, so this shows both secrets landed
    // without a passphrase prompt being involved at all (SAIP_SECRETS_PASSPHRASE answers for it).
    const listed = spawnSync(node, [distBin, 'config', 'list'], {
      env: { ...env, SAIP_SECRETS_PASSPHRASE: PASSPHRASE }, encoding: 'utf8', timeout: 30_000,
    })
    expect(listed.stdout).toContain('SAIP_R2_ACCESS_KEY_ID')
    expect(listed.stdout).toContain('SAIP_R2_SECRET_ACCESS_KEY')
    expect(listed.stdout).not.toContain('AKIAIOSFODNN7EXAMPLE')
    } finally {
      if (!done) { try { run.kill('SIGKILL') } catch { /* already reaped */ } }
    }
  }, 150_000)
})
