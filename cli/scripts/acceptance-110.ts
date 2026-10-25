/**
 * #110 acceptance — the compiled Bun binary, driven through a real terminal.
 *
 * This is the rung every other test in this repo stands on and cannot substitute for: `saip` as users
 * run it. #71 and #106 both found compiled behaviour diverging from source-run behaviour (an entry
 * guard that made the binary exit 0 silently; a `react-reconciler` import crash the bundler hid), and
 * the checklist below is the maintainer's own acceptance list, row by row, against
 * `dist/binaries/saip-<host>` — not `dist/bin.js`, not the library.
 *
 * It is a script rather than a CI test on purpose. A test that skips when the artifact is missing
 * silently stops being a gate, and the whole point of #110 is that nobody has to take that on faith.
 * CI's smoke step covers `dist/bin.js`; this covers the release artifact, and prints a verdict per row.
 *
 * Run: `node scripts/build-binaries.mjs && npx tsx scripts/acceptance-110.ts`
 * Every row runs in its own temp workspace with a scrubbed environment: fresh `HOME`, no `~/.saip`,
 * no repo `.env`, and no inherited `SAIP_*` from whoever's shell started the run.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { CSI, PtyRun, showEscapes } from '../tests/support/pty.js'
import { renderScreen } from '../tests/support/screen.js'

const BIN = join(import.meta.dirname, '..', 'dist', 'binaries', `saip-${process.platform}-${process.arch}`)
if (!existsSync(BIN)) {
  console.error(`REFUSING TO PROCEED: ${BIN} does not exist.\nBuild it first: node scripts/build-binaries.mjs`)
  process.exit(2)
}

const results: Array<{ row: string; verdict: 'PASS' | 'FAIL' | 'BLOCKED'; evidence: string }> = []
const record = (row: string, verdict: 'PASS' | 'FAIL' | 'BLOCKED', evidence: string): void => {
  results.push({ row, verdict, evidence })
  console.log(`\n[${verdict}] ${row}\n    ${evidence.replace(/\n/g, '\n    ')}`)
}

const CONFIG = `storage:
  r2:
    bucket: \${SAIP_R2_BUCKET}
    endpoint: \${SAIP_R2_ENDPOINT}
inference:
  systemone:
    enabled: false
`
/**
 * One workspace, one env, used VERBATIM by both helpers.
 *
 * Two driver bugs this replaces, both of which masqueraded as product failures: `piped()` used to
 * call `isolatedEnv()` itself, so every invocation got a FRESH temp dir and could not see the store
 * an earlier call created — `config doctor` then honestly reported "no store yet" and looked like a
 * missing report. And spreading `process.env` unscrubbed let this developer shell's own
 * `SAIP_R2_BUCKET=ai-model-storage` answer the wizard, which is #159's lesson in a new place.
 */
function workspace(opts: { withEnvFile?: boolean; withConfig?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'saip-110-'))
  const base: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(base)) if (k.startsWith('SAIP_')) delete base[k]
  const env: NodeJS.ProcessEnv = {
    ...base,
    HOME: join(dir, 'home'),
    TERM: 'xterm-256color',
    SAIP_CONFIG: join(dir, 'saip.yaml'),
    SAIP_ENV_FILE: join(dir, '.env'),
    SAIP_HOSTS_FILE: join(dir, 'hosts.yaml'),
    SAIP_SECRETS_FILE: join(dir, 'store', 'secrets.enc.json'),
    SAIP_DRY_RUN: '1',
  }
  mkdirSync(join(dir, 'home'), { recursive: true })
  mkdirSync(join(dir, 'store'), { recursive: true })
  writeFileSync(env.SAIP_HOSTS_FILE!, 'hosts:\n  - name: local\n    kind: local\n    role: both\n')
  if (opts.withConfig !== false) writeFileSync(env.SAIP_CONFIG!, CONFIG)
  if (opts.withEnvFile) writeFileSync(env.SAIP_ENV_FILE!, 'SAIP_R2_BUCKET=acceptance-bucket\nSAIP_R2_ENDPOINT=https://acct.r2.cloudflarestorage.com\n')
  return { dir, env }
}

/** A pty run against the binary, in a caller-owned workspace. */
async function inPty(args: string[], env: NodeJS.ProcessEnv, cwd: string, keys: Array<{ after?: string; text: string; afterSettleMs?: number; delayMs?: number }> = [], timeoutMs = 25_000) {
  const run = new PtyRun({ cmd: BIN, args, env, cwd, cols: 100, rows: 40 })
  for (const k of keys) {
    if (k.after) {
      const seen = await run.waitFor(k.after, 20_000)
      if (!seen) break
      await new Promise((r) => setTimeout(r, k.afterSettleMs ?? 300))
    }
    if (k.delayMs) await new Promise((r) => setTimeout(r, k.delayMs))
    run.write(k.text)
  }
  await run.settle(400)
  const r = await run.finish(timeoutMs)
  return { ...r, screen: renderScreen(r.raw, 40, 100), visible: showEscapes(r.raw) }
}

/** A piped (non-PTY) run: what an agent or script sees. `--stdin` is required for value input. */
function piped(args: string[], env: NodeJS.ProcessEnv, cwd: string, stdin?: string) {
  const r = spawnSync(BIN, args, { encoding: 'utf8', env, cwd, input: stdin, timeout: 60_000 })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

const BOX = /[\u2500-\u257f]/

// ─── Row 1: version and help ───────────────────────────────────────────
{
  const w = workspace()
  const v = piped(['--version'], w.env, w.dir)
  const h = piped(['--help'], w.env, w.dir)
  const expected = ['awake', 'sleep', 'down', 'status', 'deploy', 'profiles', 'config', 'ssh']
  const missing = expected.filter((c) => !h.stdout.includes(c))
  record('--version prints the release version; --help lists every command',
    v.code === 0 && /^\d+\.\d+\.\d+$/.test(v.stdout.trim()) && missing.length === 0 ? 'PASS' : 'FAIL',
    `--version -> ${JSON.stringify(v.stdout.trim())} (exit ${v.code}); ${expected.length} registered commands, missing from --help: ${missing.length ? missing.join(',') : 'none'}`)
}

// ─── Row 2: the wizard on a fresh store ───────────────────────────────
{
  const w = workspace({ withEnvFile: true })          // bucket/endpoint already set; credentials are asked
  delete w.env.SAIP_SECRETS_PASSPHRASE                // a FRESH store: the passphrase must be typed
  const run = new PtyRun({ cmd: BIN, args: ['config', 'init'], env: w.env, cwd: w.dir, cols: 100, rows: 60 })
  // Order matters and was assumed wrong first: the two interpolated config values are asked BEFORE
  // any credential, and the store — and so the passphrase pair — is only created at the first SECRET.
  // Enter keeps each already-set value, which is the flow a real user follows.
  await run.waitFor('SAIP_R2_BUCKET: ', 25_000)
  run.write('\r')                                          // Enter keeps the already-set value
  await run.waitFor('SAIP_R2_ENDPOINT: ', 25_000)
  run.write('\r')
  // MEASURED ORDER, twice-wrong before it was right: the store does not exist yet, but the passphrase
  // is NOT asked up front — it is asked by the FIRST SECRET WRITE, i.e. after the ACCESS_KEY_ID
  // question has been shown and answered. Assuming any other order makes the driver wait for a
  // prompt that has not come yet and answer a question that has.
  await run.waitFor('SAIP_R2_ACCESS_KEY_ID:', 25_000)
  const beforePrompt = run.output
  const guidanceBefore = /Object Read & Write/.test(beforePrompt)      // explanation precedes prompt
  run.write('AKIAIOSFODNN7EXAMPLE\r')
  // MEASURED text: the wizard asks `SAIP secret store passphrase: ` (buildStore's own prompt) at the
  // first SECRET WRITE — not `choose a passphrase`, which is `config set`'s create-with-confirm path.
  const beforePassphrase = run.output.length
  await run.waitFor('SAIP secret store passphrase:', 25_000)
  // #89's guarantee, asserted while it is still true: the explanation precedes the prompt it explains.
  const passExplain = /SAIP_SECRETS_PASSPHRASE skips this prompt|Pasting works/.test(run.output.slice(0, run.output.indexOf('SAIP secret store passphrase:')))
  run.write('acceptance-pass\r')
  // The confirm appears only when the store is being created; answer it if it does, and continue if
  // not. Waiting unconditionally for a prompt that this path may not show is how a driver hangs.
  const wantsConfirm = await run.waitFor('confirm passphrase', 3_000)
  if (wantsConfirm) run.write('acceptance-pass\r')
  // TOLERANCE DELETED (#169). This block used to answer any FURTHER passphrase prompt so the rest of
  // the row could still be measured, and that is precisely how the row ended up reporting on a wizard
  // that asked twice instead of failing for it. #86 guarantees ONE unlock per command and #169 makes
  // that guarantee cover WRITES, so a second prompt must now break the run: the paste below goes to
  // whatever prompt is actually live, the item stays unfilled, and both the count and the missing
  // write say so. A driver that absorbs a defect is a driver that ships it.
  await run.waitFor('SAIP_R2_SECRET_ACCESS_KEY:', 25_000)
  const passphraseAsks = (run.output.match(/SAIP secret store passphrase:/g) ?? []).length
  run.write(`${CSI.pasteStart}pasted-secret-value\n${CSI.pasteEnd}`)   // newline INSIDE the paste
  await new Promise((r) => setTimeout(r, 500))
  const pasteDidNotSubmit = !run.exited                                // must still be open
  run.write('\r')
  await run.waitFor('SAIP_HF_TOKEN', 25_000)
  run.write('\u0003')                                                  // Ctrl+C
  const r = await run.finish(20_000)
  const rows = renderScreen(r.raw, 40, 100).visible()
  // One unlock per command (#86) is the claim: exactly one passphrase PROMPT across the whole run.

  const summary = rows.filter((l) => /written now|still to fill|stopped by/.test(l)).map((l) => l.trim())
  const storedLine = rows.filter((l) => /stored \d+ value\(s\)/.test(l))
  record('config init on a fresh store: explanation precedes prompt, passphrase once, paste works, Ctrl+C exits 130',
    r.code === 130 && guidanceBefore && passExplain && passphraseAsks === 1 && pasteDidNotSubmit && summary.length >= 2 && storedLine.length === 0
      ? 'PASS' : 'FAIL',
    `exit=${r.code}; guidance before the prompt=${guidanceBefore}; passphrase explanation preceded its prompt=${passExplain}; `
    + `passphrase asked ${passphraseAsks}x (confirm shown: ${wantsConfirm}); `
    + `paste-with-newline did not submit=${pasteDidNotSubmit}; no "stored N value(s)" footer=${storedLine.length === 0}; `
    + `cancel summary: ${JSON.stringify(summary)}`)
}

// ─── Row 3: cards at a TTY, prompt and value on one line ─────────────
{
  const w = workspace()
  const help = await inPty(['config', 'help'], w.env, w.dir)
  const helpHasCards = BOX.test(help.raw)
  const w2 = workspace()
  w2.env.SAIP_SECRETS_PASSPHRASE = 'acceptance-pass'
  const typed = new PtyRun({ cmd: BIN, args: ['config', 'set', 'SAIP_PLAIN_VALUE'], env: w2.env, cwd: w2.dir, cols: 100, rows: 40 })
  await typed.waitFor('SAIP_PLAIN_VALUE', 25_000)
  await new Promise((r) => setTimeout(r, 300))
  typed.write('typed-value-here\r')
  const t = await typed.finish(20_000)
  const line = renderScreen(t.raw, 40, 100).visible().find((l) => l.includes('SAIP_PLAIN_VALUE')) ?? ''
  record('cards render at a TTY; the prompt and the typed value share a line',
    helpHasCards && line.includes('typed-value-here') ? 'PASS' : 'FAIL',
    `config help at a pty: ${helpHasCards ? 'box-drawing present' : 'NO box-drawing'}; prompt line after typing: ${JSON.stringify(line.trim())}`)
}

// ─── Row 4: piped output carries no boxes and no ANSI ────────────────
{
  const w = workspace({ withEnvFile: true })
  const checks: Array<[string, ReturnType<typeof piped>]> = [
    ['config init --non-interactive', piped(['config', 'init', '--non-interactive'], w.env, w.dir)],
    ['config help', piped(['config', 'help'], w.env, w.dir)],
    ['profiles --json', piped(['profiles', '--json'], w.env, w.dir)],
  ]
  const offenders = checks.filter(([, r]) => BOX.test(r.stdout) || /[\u001b\u009b]/.test(r.stdout))
  record('piped output has no box-drawing and no ANSI',
    offenders.length === 0 ? 'PASS' : 'FAIL',
    checks.map(([n, r]) => `${n}: ${BOX.test(r.stdout) ? 'BOX' : 'no-box'}/${/\u001b/.test(r.stdout) ? 'ANSI' : 'no-ansi'} (exit ${r.code})`)
      .join('; ') + (offenders.length ? ` || offenders: ${offenders.map(([n]) => n).join(', ')}` : ''))
}

// ─── Row 5: sensitivity is declared, not inferred ───────────────────
{
  const w = workspace()
  w.env.SAIP_SECRETS_PASSPHRASE = 'acceptance-pass'
  // `--stdin` is the only non-tty route; a bare `config set` must prompt, and there is no tty here.
  const mk = (name: string, value: string) => piped(['config', 'set', name, '--stdin'], w.env, w.dir, value + '\n')
  const setBucket = mk('SAIP_R2_BUCKET', 'visible-bucket')
  const setSecret = mk('SAIP_R2_SECRET_ACCESS_KEY', 'super-secret-value')
  const setUnknown = mk('SAIP_UNCATALOGUED_THING', 'inferred-value')
  const setOk = [setBucket, setSecret, setUnknown].every((r) => r.code === 0)
  const get = (name: string) => piped(['config', 'get', name], w.env, w.dir)
  const bucket = get('SAIP_R2_BUCKET'); const secret = get('SAIP_R2_SECRET_ACCESS_KEY'); const unknown = get('SAIP_UNCATALOGUED_THING')
  const list = piped(['config', 'list'], w.env, w.dir)
  const ok = setOk && bucket.stdout.includes('visible-bucket') && !secret.stdout.includes('super-secret-value')
    && /inferred/.test(unknown.stdout) && list.stdout.includes('SAIP_R2_BUCKET')
  record('config list / get follow declared sensitivity (bucket visible, credential masked, uncatalogued labelled inferred)',
    ok ? 'PASS' : 'FAIL',
    `three sets succeeded=${setOk}; bucket get: ${JSON.stringify(bucket.stdout.trim().slice(0, 55))}; `
    + `secret get leaks the value: ${secret.stdout.includes('super-secret-value')}; `
    + `secret shown masked: ${/\(\d+ chars\)|\*/.test(secret.stdout)}; uncatalogued labelled inferred: ${/inferred/.test(unknown.stdout)}`)
}

// ─── Row 6: ssh key material lifetime ───────────────────────────────
{
  const w = workspace()
  w.env.SAIP_SECRETS_PASSPHRASE = 'acceptance-pass'
  writeFileSync(w.env.SAIP_HOSTS_FILE!, 'hosts:\n  - name: lab\n    kind: hyperstack\n    role: inference\n    ssh:\n      host: 203.0.113.20\n      user: ubuntu\n')
  const gen = piped(['ssh', 'generate', '--host', 'lab'], w.env, w.dir)
  const show = piped(['ssh', 'show', '--host', 'lab'], w.env, w.dir)
  // `verify` runs real ssh against TEST-NET-2 (RFC 5737): it must fail, and must clean up either way.
  const verify = await inPty(['ssh', 'verify', '--host', 'lab'], w.env, w.dir, [], 90_000)
  const walk = (d: string, acc: string[] = []): string[] => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name)
      if (e.isDirectory()) walk(f, acc); else acc.push(f)
    }
    return acc
  }
  const leftovers = walk(w.dir).filter((f) => /id_ed25519|\.tmp-\d+/.test(f))
  const privateFiles = walk(w.dir).filter((f) => { try { return readFileSync(f, 'utf8').includes('BEGIN PRIVATE KEY') } catch { return false } })
  record('ssh generate|show|verify leaves no private key material on disk after any exit path',
    gen.code === 0 && show.stdout.includes('ssh-') && !show.stdout.includes('BEGIN PRIVATE KEY')
      && leftovers.length === 0 && privateFiles.length === 0 ? 'PASS' : 'FAIL',
    `generate exit=${gen.code}; show prints public only: ${show.stdout.includes('ssh-') && !show.stdout.includes('BEGIN PRIVATE KEY')}; `
    + `verify exit=${verify.code} (ssh to a TEST-NET address must fail); temp key dirs left: ${leftovers.length}; `
    + `files containing a private key outside the store: ${privateFiles.length}`)
}

// ─── Row 7: awake with no key says what to do ──────────────────────
{
  const w = workspace()
  w.env.SAIP_SECRETS_PASSPHRASE = 'acceptance-pass'
  writeFileSync(w.env.SAIP_HOSTS_FILE!, 'hosts:\n  - name: lab\n    kind: hyperstack\n    role: inference\n    ssh:\n      host: 203.0.113.21\n      user: ubuntu\n')
  // A store with SOME secret but no key for this host: that is the case the message must name.
  piped(['config', 'set', 'SAIP_R2_BUCKET', '--stdin'], w.env, w.dir, 'x\n')
  const r = piped(['awake', '--host', 'lab'], w.env, w.dir)
  const out = r.stdout + r.stderr
  const named = /saip ssh generate --host lab/.test(out)
  record('awake for a host with no key names `saip ssh generate --host X`',
    named ? 'PASS' : 'FAIL',
    `exit=${r.code}; names the fix=${named}; output tail: ${JSON.stringify(out.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 200))}`)
}

// ─── Row 8: config doctor reports its whole state ───────────────────
{
  const w = workspace()
  w.env.SAIP_SECRETS_PASSPHRASE = 'acceptance-pass'
  piped(['config', 'set', 'SAIP_R2_BUCKET', '--stdin'], w.env, w.dir, 'doc-bucket\n')
  const r = piped(['config', 'doctor'], w.env, w.dir)
  const out = r.stdout + r.stderr
  const want: Array<[string, RegExp]> = [
    ['store path', /path:/i], ['wraps', /wraps:/i], ['unlocking method', /unlocked by:/i],
    ['access history', /recent access/i], ['file mode', /file mode/i],
  ]
  const missing = want.filter(([n, re]) => !re.test(out)).map(([n]) => n)
  record('config doctor reports store path, wraps, unlocking method, access history, and any unattended warning',
    r.code === 0 && missing.length === 0 ? 'PASS' : 'FAIL',
    `exit=${r.code}; missing sections: ${missing.length ? missing.join(', ') : 'none'}; `
    + `unattended row present: ${/unattended/i.test(out)}; output: ${JSON.stringify(out.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 7))}`)
}

// ─── Row 9: native architectures ──────────────────────────────────
{
  const arch = `${process.platform}-${process.arch}`
  const arm = join(import.meta.dirname, '..', 'dist', 'binaries', 'saip-linux-arm64')
  const qemu = ['qemu-aarch64-static', 'qemu-aarch64', 'binfmt-wrapper'].some((b) => spawnSync('which', [b], { encoding: 'utf8' }).status === 0)
  record('every row re-run on the native architecture (linux-x64 + one ARM target)',
    qemu ? 'PASS' : 'BLOCKED',
    `this host is ${arch}, so the eight rows above ran against the native compiled binary. The ARM half needs an `
    + `arm64 kernel or qemu-user (found: ${qemu}); saip-linux-arm64 built: ${existsSync(arm)}. Native ARM coverage `
    + `belongs to the release matrix, whose runners execute each architecture — see binaries.yml/release.yml`)
}

