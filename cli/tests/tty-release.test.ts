/**
 * The terminal is borrowed per question, released per command, and ENDED at the process boundary (#172).
 *
 * Three separate things, and conflating them is what let the defect ship:
 *
 *  1. **Between questions** the handle is only un-ref'd. Destroying here would discard the bytes the
 *     user typed ahead, which is exactly what #99 exists to keep.
 *  2. **At the end of the command** the handle is destroyed and its descriptor closed. That is correct
 *     hygiene, and it is what lets an embedder open a fresh terminal for the next command — but it is
 *     NOT what makes the shipped binary exit.
 *  3. **The entry point** ends the process for any run that prompted, after draining buffered writes.
 *
 * Why 3 is necessary, measured in a real pty across `node` (tsc output), `bun run`, and
 * `bun build --compile` — the artifact shape users run — one hypothesis per mode:
 *
 *   delivered data, then destroy + closeSync(fd)   node: exit    bun: HANG
 *   delivered data, then destroy only              node: exit    bun: HANG
 *   delivered data, then closeSync(fd) only        node: exit    bun: HANG
 *   delivered data, then pause + destroy + close   node: exit    bun: HANG
 *   delivered data, handle never ref'd             node: exit    bun: HANG
 *   listener attached and removed, nothing arrives node: exit    bun: exit
 *   Ink + React imported, terminal never opened    node: exit    bun: exit
 *
 * The trigger is Bun's tty reader having *delivered* something. Ink and React are exonerated by the
 * last row, and the renderer choice is irrelevant (the plain path hangs identically under `LANG=C`).
 *
 * What can be asserted here: this environment has no controlling terminal (`/dev/tty` answers
 * `ENXIO`), so the real handle cannot be exercised from a vitest worker and no Node-level test can
 * represent the hang. The behavioural gate is `cli/scripts/check-artifact-exit.ts`, run against the
 * compiled binary by `binaries.yml` on every PR. These cases pin the contract that gate rests on.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, openSync, readFileSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { NoTerminalError, promptingHappened, promptTTY, releaseTty, ttyHeld, ttyInput } from '../src/ui/prompt.js'
import { UiService } from '../src/lib/ui.js'
import { FakeTTY, fakeStdout } from './support/fake-tty.js'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const src = (p: string): string => readFileSync(join(repoRoot, p), 'utf8')

describe('a question releases the loop without closing the terminal (#99 survives #172)', () => {
  it('un-refs the handle but never destroys it while the command still has questions left', async () => {
    const fake = new FakeTTY(fakeStdout())
    const answer = promptTTY('SAIP_FIRST: ', { stream: fake as never, echo: true })
    fake.feed('one\r')
    expect(await answer).toBe('one')

    // The distinction this file exists to keep: released, not closed.
    expect(fake.unrefCount, 'cleanup must unref so the loop can drain between questions').toBeGreaterThan(0)
    expect(fake.destroyCount, 'destroying between questions would drop typed-ahead bytes (#99)').toBe(0)
  })

  it('carries a second answer through the SAME handle, which is why destroy-per-question is wrong', async () => {
    const fake = new FakeTTY(fakeStdout())
    const first = promptTTY('SAIP_A: ', { stream: fake as never, echo: true })
    // One chunk holding both answers: the shape a paste arrives in (#99).
    fake.feed('alpha\rbeta\r')
    expect(await first).toBe('alpha')

    const second = promptTTY('SAIP_B: ', { stream: fake as never, echo: true })
    expect(await second, 'the leftover must answer the next question without new input').toBe('beta')
    expect(fake.destroyCount).toBe(0)
  })
})

describe('releaseTty gives the terminal back at the end of the command (#172)', () => {
  it('is safe when nothing was ever opened, and reports the state honestly', () => {
    expect(ttyHeld()).toBe(false)
    expect(() => releaseTty()).not.toThrow()
    expect(() => releaseTty()).not.toThrow()          // idempotent: a lifecycle hook may fire twice
    expect(ttyHeld()).toBe(false)
  })

  it('a machine with no controlling terminal refuses, holds nothing, and does not claim it prompted', () => {
    // /dev/tty is unavailable to a vitest worker, so this is the branch that runs in CI. The other
    // branch is exercised too when a terminal IS present, and neither one is silently skipped: a
    // skipped case is how #151's class was believed fixed.
    let openable = true
    try { const fd = openSync('/dev/tty', 'r+'); closeSync(fd) } catch { openable = false }

    if (!openable) {
      expect(() => ttyInput()).toThrow(NoTerminalError)
      expect(ttyHeld(), 'a failed open must not leave a half-built handle behind').toBe(false)
      // Matters for the entry point's rule: a run that REFUSED to prompt must not be forced to exit.
      expect(promptingHappened(), 'refusing for want of a terminal is not prompting').toBe(false)
    } else {
      const s = ttyInput()
      expect(ttyHeld()).toBe(true)
      expect(typeof s.destroy, 'the release path needs destroy(), not only unref').toBe('function')
      releaseTty()
      expect(ttyHeld()).toBe(false)
    }
  })

  it('the seam offers the release, so the lifecycle owner does not reach past it', () => {
    const writes: string[] = []
    const ui = new UiService(new Context() as any, { out: (t: string) => { writes.push(t) }, isTTY: false })
    expect(ui.terminalHeld).toBe(false)
    expect(() => ui.releaseTerminal()).not.toThrow()
  })
})

describe('the wiring that makes the guarantee real (#172)', () => {
  it('runCli releases the handle in its finally, so every exit path is covered', () => {
    const s = src('cli/src/index.ts')
    expect(s).toMatch(/import \{ releaseTty \} from '\.\/ui\/prompt\.js'/)
    // Inside runCli's `finally`, alongside the json-mode reset — the one place that runs for success,
    // usage error, parse error and cancellation alike.
    expect(s, "the release belongs in runCli's finally").toMatch(
      /finally \{\s*setJsonMode\(false\)[\s\S]{0,900}?releaseTty\(\)/,
    )
  })

  it('UiService routes releaseTerminal to the same release the dispatcher uses', () => {
    const s = src('cli/src/lib/ui.tsx')
    expect(s).toMatch(/import \{ releaseTty, ttyHeld \} from '\.\.\/ui\/prompt\.js'/)
    expect(s).toMatch(/releaseTerminal\(\): void \{ releaseTty\(\) \}/)
  })

  it('the entry point, and only the entry point, ends a run that prompted', () => {
    const s = src('cli/src/bin.ts')
    expect(s).toMatch(/import \{ promptingHappened \} from '\.\/ui\/prompt\.js'/)
    // Conditional on having prompted: a piped, non-prompting command keeps its normal lifecycle.
    expect(s).toMatch(/if \(promptingHappened\(\)\) \{[\s\S]*?process\.exit\(code\)/)
    // …and it drains first, because process.exit() truncates a pipe (the #147 empty-stdout family).
    expect(s).toMatch(/await flush\(process\.stdout\)/)
    expect(s).toMatch(/stream\.write\('', \(\) => resolve\(\)\)/)
    // No command module may do this: commands are library code with a caller that owns the process.
    const offenders = ['commands/config.ts', 'commands/config-init.ts', 'commands/ssh.ts', 'commands/status.ts']
      .filter((f) => /process\.exit\(/.test(src(`cli/src/${f}`)))
    expect(offenders, `process.exit() in a command: ${offenders.join(', ')}`).toEqual([])
  })

  it('the release destroys and closes the descriptor, and says out loud what it does not fix', () => {
    const s = src('cli/src/ui/prompt.ts')
    expect(s).toMatch(/export function releaseTty\(\): void \{[\s\S]*?stream\.destroy\(\)[\s\S]*?closeSync\(fd\)/)
    expect(s).toMatch(/no destroy\(\)/,
      'a runtime whose handle cannot be destroyed must fail loudly, not degrade silently (#172)')
    // The comment is part of the fix: an earlier revision of this file claimed destroy() was the thing
    // that released Bun. It was not, and the record now says so.
    expect(s).toMatch(/It does NOT make the[\s\S]{0,120}?compiled artifact exit/)
  })

  it('CI runs the behavioural gate against the compiled artifact, where the defect lives', () => {
    const workflow = src('.github/workflows/binaries.yml')
    expect(workflow, 'the prompt-path gate must execute the compiled binary, not dist/bin.js')
      .toMatch(/check-artifact-exit\.ts/)
    expect(existsSync(join(repoRoot, 'cli/scripts/check-artifact-exit.ts'))).toBe(true)
  })
})
