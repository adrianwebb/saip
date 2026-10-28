/**
 * SPIKE probe child (#154) — a real program, run inside a real pty, whose behaviour is the measurement.
 *
 * It is NOT a unit test with the engine transplanted into it: it imports the production terminal stream
 * (`ttyInput()`, the unref'd `/dev/tty` `ReadStream` from #110 F1) and the candidate engine, then prints
 * the facts the probes need — active handles, listener counts, the answered value — and returns WITHOUT
 * calling `process.exit()`. That is the whole point of probe 1: if an Ink instance leaves a handle held,
 * a program that never exits is exactly the shipped defect, so the child must be allowed to hang.
 */
import { ttyInput } from '../../src/ui/prompt.js'
import { askInkOnce, InkWizard, type InkOptions } from './ink-engine.js'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}
const probe = flag('probe') ?? '1'
const engineKind = flag('engine') ?? 'once'
const interactive = flag('interactive') !== '0'

const marker = (text: string): void => { process.stdout.write(`${text}\n`) }

function options(extra: InkOptions = {}): InkOptions {
  // --secret=1 selects the hidden path; without it a case stays visible.
  const base: InkOptions = { stream: ttyInput(), stdout: process.stdout, interactive }
  if (flag('secret') === '1') base.secret = true
  return { ...base, ...extra }
}

/** Printed after every answer: whether the terminal handle and its listeners were released. */
function reportState(tag: string): void {
  const stream = ttyInput()
  const info = process.getActiveResourcesInfo()
  marker(
    `STATE[${tag}] readable=${stream.listenerCount('readable')} data=${stream.listenerCount('data')}` +
    ` isRaw=${stream.isRaw} total=${info.length} resources=${JSON.stringify(info)}`,
  )
}

async function askOnce(question: string, extra: InkOptions = {}): Promise<string> {
  if (engineKind === 'tty') {
    // The CONTROL: the shipped engine, same terminal, same harness. If this hangs too, the harness is
    // the suspect — not Ink. Attribution before conclusion.
    const { ttyEngine } = await import('../../src/ui/input.js')
    return ttyEngine.ask(question, options(extra) as never)
  }
  if (engineKind === 'wizard') {
    const w = new InkWizard(options())
    w.start()
    const answer = await w.ask(question, extra)
    reportState(question)
    w.stop()
    return answer
  }
  return askInkOnce(question, options(extra))
}

async function main(): Promise<void> {
  switch (probe) {
    // 1 — TERMINATION. Print, report state, and let the process drain naturally.
    case '1': {
      const value = await askOnce('SAIP_R2_BUCKET: ', { secret: false })
      marker(`ANSWERED=${value}`)
      reportState('after-answer')
      // No process.exit(): reaching here and then terminating is the claim under test.
      return
    }
    // 2 — ORDERING. Guidance is written first, then the live prompt takes the same stream.
    case '2': {
      marker('EXPLAIN-ONE: SAIP_R2_BUCKET holds the R2 bucket name.')
      marker('EXPLAIN-TWO: create it at dash.cloudflare.com → R2 Object Storage.')
      const value = await askOnce('SAIP_R2_BUCKET: ', { secret: false })
      marker(`ANSWERED=${value}`)
      marker('AFTER-PROMPT: the next line must start at column zero.')
      return
    }
    // 2b — ORDERING with the hidden variant, where the engine writes its own `\r\n`.
    case '2h': {
      marker('EXPLAIN-ONE: passphrase guidance, printed before the prompt (#78).')
      const value = await askOnce('SAIP secret store passphrase: ', { secret: true })
      marker(`LEN=${value.length}`)
      marker('AFTER-PROMPT: column zero check follows a hidden prompt.')
      return
    }
    // 3 — TWO QUESTIONS, typed-ahead paste arriving as one chunk.
    case '3': {
      if (engineKind === 'wizard') {
        const w = new InkWizard(options())
        w.start()
        const bucket = w.ask('SAIP_R2_BUCKET: ', { secret: false })
        const endpoint = w.ask('SAIP_R2_ENDPOINT: ', { secret: false })
        const answers = await Promise.all([bucket, endpoint])
        reportState('wizard-done')
        marker(`ANSWERED=${answers[0]}|${answers[1]}`)
        w.stop()
        return
      }
      const first = await askOnce('SAIP_R2_BUCKET: ', { secret: false })
      reportState('between-questions')
      const second = await askOnce('SAIP_R2_ENDPOINT: ', { secret: false })
      marker(`ANSWERED=${first}|${second}`)
      reportState('after-both')
      return
    }
    // 4 — MASKING + BRACKETED PASTE. A paste's newline is content; Ctrl+D ends input.
    case '4': {
      const mode = flag('mode') ?? 'paste'
      if (mode === 'cancel') {
        try {
          await askOnce('SAIP_R2_BUCKET: ', { secret: true })
          marker('ANSWERED-NO-CANCEL')
        } catch (error) {
          marker(`CANCELLED=${(error as Error).name}`)
          marker(`CODE=${process.exitCode ?? 'unset'}`)
          process.exitCode = 130
        }
        reportState('after-cancel')
        return
      }
      if (mode === 'ctrld') {
        const value = await askOnce('SAIP_R2_BUCKET: ', { secret: true })
        marker(`ANSWERED=${JSON.stringify(value)}`)
        return
      }
      const value = await askOnce('SAIP_R2_SECRET_ACCESS_KEY: ', { secret: true })
      marker(`ANSWERED=${JSON.stringify(value)}`)
      reportState('after-paste')
      return
    }
    // 5 — duplicate-listener watch: three questions through one wizard.
    case '5': {
      const w = new InkWizard(options())
      w.start()
      reportState('after-start')
      const jobs = ['Q1: ', 'Q2: ', 'Q3: '].map((q) => w.ask(q, { secret: false }))
      w.ask('Q4: ', { secret: false }).then((v) => jobs.push(Promise.resolve(v)))
      const answers: string[] = []
      for (const j of jobs) answers.push(await j)
      reportState('done')
      marker(`ANSWERED=${answers.join('|')}`)
      w.stop()
      return
    }
    default:
      marker(`UNKNOWN_PROBE=${probe}`)
      process.exitCode = 64
  }
}

void main().then(() => reportState('exit-point')).catch((error: unknown) => {
  marker(`ERROR=${(error as Error).name}: ${(error as Error).message}`)
  reportState('error')
  process.exitCode = 1
})
