/**
 * The pty harness (#154).
 *
 * Every terminal guarantee this CLI ships — /dev/tty rather than stdin (#73), bracketed paste so a
 * pasted newline is content (#99), Ctrl+C as an explicit 130 because raw mode kills ISIG, `\r\n`
 * termination because raw mode has no OPOST, guidance printed before the prompt it explains (#78) —
 * is a property of the *terminal*, and until now CI could only assert it through injected fake
 * streams. Three tests this session reported success against broken builds doing it with shells and
 * pipes: `script -qec` returns 0 when its OWN stdin hits EOF while the child is still alive, and a
 * 64 KB pipe buffer absorbs ten output lines so `| head -1` never raises the EPIPE it was meant to
 * prove. A pty has neither of those failure modes: it is the kernel's terminal, with a real exit
 * event and a real window size.
 *
 * Two properties make this trustworthy, and both are asserted in `pty-harness.test.ts` before any
 * product claim is taken from it:
 *
 * 1. **Exit is observed, not inferred.** `finished` resolves from node-pty's `onExit` only. A child
 *    that prints a convincing completion marker and then hangs is reported `hung: true` with
 *    `code: null` — the marker is evidence about output, never about termination.
 * 2. **A timeout is a verdict, not a silence.** If nothing exits within the deadline the harness
 *    kills the child and returns `hung: true`, so a hang fails LOUDLY instead of hanging CI.
 */
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import * as nodePty from 'node-pty'

// node-pty is CJS; under a bundler-transpiled ESM import the named export can sit on `default`.
const ptySpawn: typeof nodePty.spawn =
  (nodePty as { spawn?: typeof nodePty.spawn }).spawn ??
  (nodePty as { default?: { spawn: typeof nodePty.spawn } }).default!.spawn
if (typeof ptySpawn !== 'function') throw new Error('node-pty did not load: no spawn export')

export interface PtySpec {
  /** Absolute path or a name resolvable by node-pty. Spawned directly — not through a shell. */
  cmd: string
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  cols?: number
  rows?: number
}

export interface PtyResult {
  /** The child's exit code, or null when it never exited within the deadline. */
  code: number | null
  signal: number | null
  /**
   * True when the child died from a signal.
   *
   * MEASURED here, not assumed: node-pty reports a signal death as `code: 0, signal: N` —
   * `process.abort()` comes back `{code: 0, signal: 6}`, self-`SIGKILL` `{code: 0, signal: 9}`.
   * So `code === 0` alone cannot mean "exited cleanly"; a check written that way passes for a segfault.
   */
  killedBySignal: boolean
  /** True only for a genuine clean exit: code 0 AND no signal. */
  clean: boolean
  /** True when the deadline elapsed with the child still alive — the hang class (#151). */
  hung: boolean
  /** Everything the child wrote, verbatim, escape sequences included. */
  raw: string
  /** Milliseconds from spawn to exit, or to the deadline when `hung`. */
  elapsedMs: number
  timedOutMs: number
}

/**
 * A live child attached to a real terminal.
 *
 * `waitFor` searches the output ACCUMULATED SO FAR, so a sequence that has already scrolled past is
 * still found — prompt ordering assertions depend on that.
 */
export class PtyRun {
  private readonly chunks: string[] = []
  private exit: { code: number; signal: number } | null = null
  private exitWaiters: Array<(e: { code: number; signal: number } | null) => void> = []
  readonly pid: number
  private readonly proc: ReturnType<typeof nodePty.spawn>

  constructor(spec: PtySpec) {
    this.proc = ptySpawn(spec.cmd, spec.args ?? [], {
      name: 'xterm-256color',
      cols: spec.cols ?? 80,
      rows: spec.rows ?? 24,
      cwd: spec.cwd ?? process.cwd(),
      env: spec.env as { [key: string]: string } | undefined,
    })
    this.pid = this.proc.pid
    this.proc.onData((d) => this.chunks.push(d))
    this.proc.onExit(({ exitCode, signal }) => {
      this.exit = { code: exitCode, signal }
      for (const w of this.exitWaiters) w(this.exit)
      this.exitWaiters = []
    })
  }

  write(text: string): void { this.proc.write(text) }

  /** Raw output so far, escape sequences intact. */
  get output(): string { return this.chunks.join('') }

  /** Output with control sequences made visible, for quoting in a report. */
  get visible(): string { return showEscapes(this.output) }

  get exited(): boolean { return this.exit !== null }

  /** Resolve true if `pattern` appears in the output, false if the deadline passes first. */
  async waitFor(pattern: string | RegExp, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms
    for (;;) {
      const text = this.output
      if (typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)) return true
      if (this.exited || Date.now() > deadline) return false
      await sleep(10)
    }
  }

  /** Let the child paint, then hand back the accumulated output. */
  async settle(ms: number): Promise<string> {
    await sleep(ms)
    return this.output
  }

  /**
   * Await termination. Resolves null on timeout after KILLING the child, so a hung probe cannot
   * outlive the test that started it.
   */
  async finish(timeoutMs: number): Promise<PtyResult> {
    const started = Date.now()
    const hung = await new Promise<boolean>((resolve) => {
      let settled = false
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve(true) } }, timeoutMs)
      this.exitWaiters.push((e) => {
        if (e && !settled) { settled = true; clearTimeout(timer); resolve(false) }
      })
    })
    const raw = this.output
    if (hung) this.kill('SIGKILL')
    const exit = this.exit
    const code = hung ? null : exit?.code ?? null
    const signal = hung ? null : exit?.signal ?? null
    return {
      code,
      signal,
      killedBySignal: !hung && (signal ?? 0) !== 0,
      clean: !hung && code === 0 && (signal ?? 0) === 0,
      hung,
      raw,
      elapsedMs: Date.now() - started,
      timedOutMs: timeoutMs,
    }
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): void {
    try { this.proc.kill(signal as NodeJS.Signals) } catch { /* already gone */ }
  }
}

/** Run a child to completion (or to a declared hang). Never leaves a process behind. */
export async function runInPty(spec: PtySpec, timeoutMs = 15_000): Promise<PtyResult> {
  const run = new PtyRun(spec)
  return run.finish(timeoutMs)
}

/**
 * A private `$HOME` with SAIP's every state path pointed inside it.
 *
 * Non-negotiable: one test run in this repo wrote a stray key into the maintainer's real
 * `~/.saip/keys`. Every path SAIP consults is therefore redirected, `SAIP_ENV_FILE` included so the
 * repo's own `.env` is never autoloaded, and the result is checked: a path that resolves inside the
 * real home directory throws instead of quietly writing there.
 */
export function isolatedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv & { dir: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'saip-pty-')))
  const realHome = homedir()
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    // State: nothing shared with the machine this runs on.
    SAIP_SECRETS_FILE: join(dir, 'secrets.enc.json'),
    SAIP_ENV_FILE: join(dir, '.env'),
    SAIP_HOSTS_FILE: join(dir, 'hosts.yaml'),
    SAIP_CONFIG: join(dir, 'saip.yaml'),
    // An existing passphrase means the probes exercise prompting, not keyring setup.
    SAIP_SECRETS_PASSPHRASE: 'spike-passphrase',
    ...extra,
  }
  for (const [key, value] of Object.entries(env)) {
    if (!value || !key.startsWith('SAIP_')) continue
    const resolved = value.startsWith(dir) || value.startsWith(home)
    if (!resolved && value.startsWith(realHome)) {
      throw new Error(`isolatedEnv: ${key} points inside the real home (${value})`)
    }
  }
  return { ...env, dir } as NodeJS.ProcessEnv & { dir: string }
}

/** Replace every escape/byte a terminal acts on with a readable marker, so evidence is quotable. */
export function showEscapes(text: string): string {
  return text
    .replace(/\x1b\[<ESC>/g, '')
    .replace(/\x1b/g, '␛')
    .replace(/\r/g, '␍\n')
    .replace(/\n/g, '␊\n')
    .replace(/\x03/g, '␃')
    .replace(/\x04/g, '␄')
    .replace(/\x7f/g, '␡')
}

export const CSI = {
  pasteOn: '\x1b[?2004h',
  pasteOff: '\x1b[?2004l',
  pasteStart: '\x1b[200~',
  pasteEnd: '\x1b[201~',
  altScreenOn: '\x1b[?1049h',
  altScreenOff: '\x1b[?1049l',
  cursorHide: '\x1b[?25l',
  cursorShow: '\x1b[?25h',
  clearLine: '\x1b[2K',
  clearDown: '\x1b[J',
} as const

export const CTRL = { c: '\x03', d: '\x04', backspace: '\x7f' } as const

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
