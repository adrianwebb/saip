/**
 * The pty harness self-test (#154).
 *
 * Nothing in this spike is trustworthy until this file passes, because the alternative is what already
 * happened three times this session: a test that CANNOT fail, reporting green against a broken build.
 * The specific illusions were `script -qec`, which exits 0 when its own stdin reaches EOF while the
 * child process is still alive, and a 64 KB pipe buffer that absorbs ten output lines so a reader
 * closing early never raises the EPIPE it was supposed to prove. Both "passed".
 *
 * So the tests here are falsifiable by construction: each feeds the harness a known outcome — a known
 * exit code, a known hang — and asserts the harness NAMPS it. The hang cases deliberately print a
 * convincing completion marker before refusing to exit; if the harness ever mistakes output for
 * termination, those cases go red.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { CTRL, CSI, PtyRun, isolatedEnv, runInPty, showEscapes } from './support/pty.js'

const node = process.execPath

describe('the pty harness proves it can see an exit code (#154 gate)', () => {
  it('reports the real exit code of a child that exits 7', async () => {
    const r = await runInPty({ cmd: node, args: ['-e', 'process.exit(7)'] }, 8_000)
    expect(r.hung).toBe(false)
    expect(r.code).toBe(7)
  }, 20_000)

  it('reports 0 for a clean child, so a green run means something', async () => {
    const r = await runInPty({ cmd: node, args: ['-e', 'console.log("ok")'] }, 8_000)
    expect(r.code).toBe(0)
    expect(r.hung).toBe(false)
    expect(r.raw).toContain('ok')
  }, 20_000)

  it('sees a signal death AS a signal death — not as a clean exit', async () => {
    // The harness defect this case exists to catch: node-pty reports `process.abort()` as
    // `code: 0`, so any check that treats 0 as success would call a SIGABRT a pass. Measured shapes:
    //   exit(7)      → code 7, signal 0        abort()  → code 0, signal 6
    //   SIGTERM      → code 0, signal 15        exitCode=130 → code 130, signal 0
    const abort = await runInPty({ cmd: node, args: ['-e', 'process.abort()'] }, 8_000)
    expect(abort.hung).toBe(false)
    expect(abort.signal).toBe(6)
    expect(abort.killedBySignal).toBe(true)
    expect(abort.clean).toBe(false)          // ← the assertion that cannot be satisfied by `code === 0`

    const term = await runInPty({ cmd: node, args: ['-e', 'process.kill(process.pid,"SIGTERM")'] }, 8_000)
    expect(term.signal).toBe(15)
    expect(term.killedBySignal).toBe(true)
    expect(term.clean).toBe(false)

    const clean = await runInPty({ cmd: node, args: ['-e', 'console.log("x")'] }, 8_000)
    expect(clean.signal).toBe(0)
    expect(clean.killedBySignal).toBe(false)
    expect(clean.clean).toBe(true)

    // 130 is the code Ctrl+C cancellation must produce (#78 follow-up), so it has to survive the pty.
    const cancelled = await runInPty({ cmd: node, args: ['-e', 'process.exitCode=130'] }, 8_000)
    expect(cancelled.code).toBe(130)
    expect(cancelled.clean).toBe(false)
  }, 30_000)
})

describe('the pty harness proves it can see a HANG (#154 gate)', () => {
  // THE test that keeps the harness honest. This child prints `RESULT READY` and then sits in an
  // event loop — exactly the #151 defect shape, where `config set NAME` printed `stored …` and never
  // returned. `script -qec` called that a success. So: marker present, verdict must still be "hung".
  it('calls a child that prints its result and never exits a HANG, not a pass', async () => {
    const r = await runInPty(
      { cmd: node, args: ['-e', 'console.log("RESULT READY"); setInterval(() => {}, 1000)'] },
      1_500,
    )
    expect(r.raw).toContain('RESULT READY')   // it did print a convincing result…
    expect(r.hung).toBe(true)                  // …and that is NOT a pass
    expect(r.code).toBeNull()
    expect(r.timedOutMs).toBe(1_500)
  }, 20_000)

  it('kills the hung child instead of leaving it running for CI to inherit', async () => {
    const run = new PtyRun({
      cmd: node,
      args: ['-e', 'console.log("MARK"); setInterval(() => {}, 1000)'],
    })
    const pid = run.pid
    const r = await run.finish(1_200)
    expect(r.hung).toBe(true)
    await new Promise((res) => setTimeout(res, 300))
    // Signal 0 on a dead pid throws ESRCH; alive returns 0.
    let alive = true
    try { process.kill(pid, 0); alive = true } catch { alive = false }
    expect(alive).toBe(false)
  }, 20_000)

  it('detects a sleeping child still alive at 1.5s — the measurement #154 recorded', async () => {
    const run = new PtyRun({ cmd: '/bin/sleep', args: ['30'] })
    const seen = await run.waitFor('nothing-never-printed', 1_500)
    expect(seen).toBe(false)
    expect(run.exited).toBe(false)             // still alive: that is the hang signal
    const r = await run.finish(500)
    expect(r.hung).toBe(true)
  }, 20_000)

  it('reports the code of a child that exited BEFORE finish() was called', async () => {
    // THE regression this harness actually shipped with. `waitFor`/`settle` are how a probe lets a
    // prompt paint before calling `finish`; if `finish` only registers an `onExit` waiter, a child
    // that already exited is reported as HUNG. That false verdict claimed the shipped CLI's
    // `config set` never returned — until an independent python `pty.fork` check said `exit=0`.
    const run = new PtyRun({ cmd: node, args: ['-e', 'console.log("quick"); process.exit(7)'] })
    await run.waitFor('quick', 8_000)                       // exit lands during this window
    await run.settle(150)
    expect(run.exited).toBe(true)                           // the child is already dead
    const r = await run.finish(5_000)                        // …and finish must still see code 7
    expect(r.hung).toBe(false)
    expect(r.code).toBe(7)
    expect(r.signal).toBe(0)
  }, 20_000)

  it('distinguishes "exited during the settle window" from "still alive at the deadline"', async () => {
    // Both children print the same marker. One then exits, one then hangs. The harness must give
    // opposite verdicts on identical output — the property that makes every termination claim here
    // trustworthy, and the one the bug above violated.
    const exits = new PtyRun({ cmd: node, args: ['-e', 'console.log("MARK"); setTimeout(() => process.exit(3), 400)'] })
    await exits.waitFor('MARK', 8_000)
    await exits.settle(900)
    const a = await exits.finish(4_000)
    expect(a.code).toBe(3)
    expect(a.hung).toBe(false)

    const hangs = new PtyRun({ cmd: node, args: ['-e', 'console.log("MARK"); setInterval(() => {}, 1000)'] })
    await hangs.waitFor('MARK', 8_000)
    await hangs.settle(900)
    const b = await hangs.finish(1_200)
    expect(b.hung).toBe(true)
    expect(b.code).toBeNull()
  }, 30_000)
})

describe('the pty harness delivers a terminal, not a pipe', () => {
  it('gives the child a real isTTY on all three standard streams', async () => {
    const probe = [
      'process.stdout.isTTY', 'process.stderr.isTTY', 'process.stdin.isTTY',
      'process.stdout.columns', 'process.stdout.rows',
    ]
    const r = await runInPty({
      cmd: node,
      args: ['-e', `console.log(JSON.stringify({${probe.map((p) => `"${p}":${p}`).join(',')}}))`],
    }, 8_000)
    expect(r.code).toBe(0)
    const json = JSON.parse(r.raw.match(/\{.*\}/s)![0])
    expect(json['process.stdout.isTTY']).toBe(true)
    expect(json['process.stderr.isTTY']).toBe(true)
    expect(json['process.stdin.isTTY']).toBe(true)
    expect(json['process.stdout.columns']).toBe(80)   // the window we asked node-pty for
    expect(json['process.stdout.rows']).toBe(24)
  }, 20_000)

  it('hands the child a controlling terminal, so /dev/tty opens', async () => {
    // The whole #73 guarantee depends on this: a prompt must be able to open /dev/tty. Piped stdin
    // (`--stdin`) has no controlling terminal, and a pty does.
    const r = await runInPty({
      cmd: node,
      args: ['-e', 'const{openSync,closeSync}=require("node:fs");const fd=openSync("/dev/tty","r+");console.log("TTY_FD="+fd);closeSync(fd)'],
    }, 8_000)
    expect(r.raw).toMatch(/TTY_FD=\d+/)
    expect(r.code).toBe(0)
  }, 20_000)

  it('captures a 64 KB+ flood VERBATIM — the pipe-buffer illusion cannot hide behind it', async () => {
    // The EPIPE test that "passed" against a broken build worked on a 64 KB pipe absorbing ten lines.
    // Here we assert the pty surfaces everything it received, and that raw byte count is not a
    // coincidence of buffer size: 200 KB of output arrives with no truncation and no reader needed.
    const r = await runInPty({
      cmd: node,
      args: ['-e', 'for(let i=0;i<2000;i++)console.log("LINE_"+String(i).padStart(4,"0")+"_".repeat(100))'],
      cols: 200,
    }, 20_000)
    expect(r.code).toBe(0)
    expect(r.raw).toContain('LINE_0000')
    expect(r.raw).toContain('LINE_1999')
    expect(r.raw.length).toBeGreaterThan(200_000)
  }, 30_000)

  it('passes escape sequences through untouched (a terminal would have acted on them)', async () => {
    const r = await runInPty({
      cmd: node,
      args: ['-e', `process.stdout.write(${JSON.stringify(`${CSI.cursorHide}abc${CSI.clearLine}d`)})`],
    }, 8_000)
    expect(r.raw).toContain(`${CSI.cursorHide}abc${CSI.clearLine}`)
    expect(showEscapes(r.raw)).toContain('␛[?25l')
  }, 20_000)
})

describe('isolation: a probe cannot touch the maintainer’s state (#154 hard rule)', () => {
  it('points every SAIP state path at a fresh temp dir', () => {
    const env = isolatedEnv()
    const dir = env.dir
    expect(dir).not.toBe(join(process.env.HOME ?? '', '.saip'))
    for (const key of ['SAIP_SECRETS_FILE', 'SAIP_ENV_FILE', 'SAIP_HOSTS_FILE', 'SAIP_CONFIG']) {
      expect(env[key]!.startsWith(dir)).toBe(true)
    }
    expect(env.HOME!.startsWith(dir)).toBe(true)
    expect(existsSync(dir)).toBe(true)
  })

  it('refuses an override that resolves inside the real home directory', () => {
    const home = execFileSync('sh', ['-c', 'echo $HOME'], { encoding: 'utf8' }).trim()
    expect(() => isolatedEnv({ SAIP_SECRETS_FILE: join(home, '.saip', 'keys', 'x.enc.json') }))
      .toThrow(/real home/)
  })

  it('lets a child see only the isolated HOME — a probe cannot write ~/.saip by accident', async () => {
    const env = isolatedEnv()
    const realHome = process.env.HOME ?? ''
    const r = await runInPty({
      cmd: node,
      args: ['-e', 'console.log("HOME=["+process.env.HOME+"]")'],
      env,
    }, 8_000)
    const seen = r.raw.match(/HOME=\[([^\]]*)\]/)![1]
    expect(seen).toBe(env.HOME)
    expect(seen).not.toBe(realHome)
    expect(seen.startsWith(env.dir)).toBe(true)
  }, 20_000)

  it('leaves no state behind in the real ~/.saip when a probe runs', async () => {
    // #154's non-negotiable rule, checked as an observable rather than promised: run a child that
    // would write wherever SAIP points, then assert the real home gained nothing under .saip.
    const before = existsSync(join(process.env.HOME ?? '', '.saip'))
      ? execFileSync('sh', ['-c', 'find "$HOME/.saip" -type f | sort'], { encoding: 'utf8' })
      : ''
    const env = isolatedEnv()
    const r = await runInPty({
      cmd: node,
      args: ['-e', 'require("node:fs").writeFileSync(process.env.SAIP_SECRETS_FILE, "{}")'],
      env,
    }, 8_000)
    expect(r.code).toBe(0)
    expect(existsSync(env.SAIP_SECRETS_FILE!)).toBe(true)
    const after = existsSync(join(process.env.HOME ?? '', '.saip'))
      ? execFileSync('sh', ['-c', 'find "$HOME/.saip" -type f | sort'], { encoding: 'utf8' })
      : ''
    expect(after).toBe(before)
  }, 20_000)
})
