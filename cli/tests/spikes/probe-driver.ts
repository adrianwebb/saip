/**
 * SPIKE probe driver (#154) — runs the probe child in a real pty and prints the evidence.
 *
 * Deliberately a script, not a test: it PRODUCES the quoted output the report is built from, and the
 * pass/fail assertions live in `ink-engine-gate.test.ts` where CI can run them. Every child runs with
 * `isolatedEnv()` (#154's hard rule), and every run reports the harness's own verdict — code, signal,
 * or hang — because "the command printed its answer and never returned" is the defect being measured.
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PtyRun, isolatedEnv, showEscapes, type PtyResult } from '../support/pty.js'
import { renderScreen } from '../support/screen.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const child = join(here, 'probe-child.tsx')
const tsx = join(here, '..', '..', 'node_modules', '.bin', 'tsx')

export interface ProbeCase {
  id: string
  args: string[]
  /** What to type, and when. `after` waits for that marker in the child's output first. */
  keys: Array<{ after?: string; text: string; delayMs?: number }>
  settleMs?: number
  finishMs?: number
}

export interface ProbeEvidence {
  id: string
  result: PtyResult
  screenRows: string[]
  unparsed: string[]
  visibleOutput: string
}

export async function runProbe(c: ProbeCase, env: NodeJS.ProcessEnv): Promise<ProbeEvidence> {
  const run = new PtyRun({ cmd: tsx, args: [child, ...c.args], env, cols: 80, rows: 24 })
  for (const k of c.keys) {
    if (k.after !== undefined) {
      const found = await run.waitFor(k.after, 20_000)
      if (!found) break
    }
    if (k.delayMs) await new Promise((r) => setTimeout(r, k.delayMs))
    run.write(k.text)
  }
  await run.settle(c.settleMs ?? 300)
  const result = await run.finish(c.finishMs ?? 8_000)
  const screen = renderScreen(result.raw, 24, 80)
  return {
    id: c.id,
    result,
    screenRows: screen.visible(),
    unparsed: screen.unparsed,
    visibleOutput: showEscapes(result.raw),
  }
}

export const PASTE = '\x1b[200~'
export const PASTE_END = '\x1b[201~'
