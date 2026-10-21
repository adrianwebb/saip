/**
 * SPIKE (#154): candidate Ink-driven `InputEngine`s, built to be measured, not shipped.
 *
 * Production stays on `ttyEngine`; this file lives under `tests/spikes/` precisely so a spike cannot
 * become a default by accident. Both shapes here implement the documented `InputEngine` contract —
 * read the controlling terminal and never stdin (#73), a pasted newline is CONTENT (#99), `Ctrl+C`
 * cancels because raw mode killed ISIG, `Ctrl+D` ends input, and the line is closed with `\r\n`
 * because raw mode has no OPOST.
 *
 * Two choices are forced by Ink 8's own measured behaviour, not by taste:
 *
 * - `usePaste` is subscribed. Ink routes a bracketed paste to the paste channel ONLY when a paste
 *   listener exists; with none, the whole blob is handed to `useInput` as one string
 *   (`build/components/App.js:212-220`). Subscribing is what keeps a paste's newlines out of the
 *   terminator logic at all.
 * - the `useInput` handler scans its string CHARACTER BY CHARACTER. Ink's `splitControlBytes` isolates
 *   only backspace and Ctrl+C from a chunk — its comment is explicit that `\r` is left inside because
 *   it "can legitimately appear inside pasted text" (`build/input-parser.js:112-132`). So a
 *   typed-ahead `one\rtwo\r`, which a scripted client and a paste both produce, arrives as ONE text
 *   event and `key.return` is never true for it.
 */
import React, { useEffect, useRef, useState } from 'react'
import { render, useApp, useInput, usePaste, Text } from 'ink'
import type { ReadStream } from 'node:tty'
import type { InputEngine } from '../../src/ui/input.js'

export class WizardCancelled extends Error { readonly name = 'WizardCancelled' }

export interface InkOptions {
  secret?: boolean
  echo?: boolean
  /** The terminal to read: `ttyInput()` in production, a fake tty in the gate suite. */
  stream?: ReadStream
  stdout?: NodeJS.WriteStream
  /** Probe 2 measures both halves of this. */
  interactive?: boolean
}

/** Un-consumed bytes, remembered per question so typed-ahead input survives to the next one (#99). */
export const leftover = new WeakMap<object, string>()

/** True when hidden input was asked for: secret wins, else echo unset means hidden. */
export function isHidden(opts: InkOptions): boolean {
  return opts.secret ?? (opts.echo === undefined ? true : !opts.echo)
}

interface Scan {
  value: string
  carry: string
  cancelled: boolean
  answered: boolean
}

/**
 * Consume one input event. `endOfInput` is the `\u0004` case the caller detected via `key`.
 *
 * Returns the answer if the event terminated it, and leaves everything after the terminator in
 * `carry` — the #99 fix, expressed for this engine.
 */
export function feed(s: Scan, text: string, opts: { returned?: boolean; eof?: boolean } = {}): string | null {
  if (s.answered) return null
  if (opts.eof) { s.answered = true; return s.value }
  let idx = -1
  if (opts.returned) {
    // A lone Enter keystroke: the terminal sent `\r` as its own event.
    s.answered = true
    return s.value
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\r' || ch === '\n') { idx = i; break }
    if (ch === '\u0004') { idx = i; s.answered = true; s.carry += text.slice(i + 1); return s.value }
    if (ch === '\u007f' || ch === '\u0008') { s.value = s.value.slice(0, -1); continue }
    if (ch.codePointAt(0)! < 0x20) continue
    s.value += ch
  }
  if (idx >= 0) { s.answered = true; s.carry += text.slice(idx + 1); return s.value }
  return null
}

export function newScan(): Scan { return { value: '', carry: '', cancelled: false, answered: false } }

interface Job {
  question: string
  hidden: boolean
  scan: Scan
  resolve: (v: string) => void
  reject: (e: Error) => void
}

function Field({ job, onSettle }: { job: Job; onSettle: (answer: string | Error) => void }) {
  const [, tick] = useState(0)
  const ref = useRef(job)
  ref.current = job

  usePaste((pasted) => {
    // Paste content NEVER consults the terminator logic: a clipboard secret's newline is content.
    ref.current.scan.value += pasted
    tick((n) => n + 1)
  })

  useInput((input, key) => {
    const s = ref.current.scan
    if (s.answered) return
    if (key.ctrl && key.name === 'c') {
      s.cancelled = true
      s.answered = true
      return onSettle(new WizardCancelled('cancelled by user'))
    }
    const answer = feed(s, input, {
      returned: input.length === 1 && key.return,
      eof: key.ctrl && key.name === 'd',
    })
    if (s.answered) {
      if (s.carry) leftover.set(ref.current, s.carry)
      onSettle(answer ?? s.value)
      return
    }
    tick((n) => n + 1)
  })

  return <Text>{ref.current.question}{ref.current.hidden ? '' : ref.current.scan.value}</Text>
}

/**
 * Shape A — one Ink instance per question.
 *
 * `waitUntilExit` is not used to detect completion: the promise settles from the field, then we
 * unmount. Probe 1 measures whether the process then terminates by itself.
 */
export function askInkOnce(question: string, opts: InkOptions = {}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const job: Job = { question, hidden: isHidden(opts), scan: newScan(), resolve, reject }
    const queued = leftover.get(job)
    let settled = false
    const settle = (answer: string | Error): void => {
      if (settled) return
      settled = true
      instance.unmount()
      if (job.hidden) (opts.stdout ?? process.stdout).write('\r\n')
      if (answer instanceof Error) reject(answer)
      else resolve(answer)
    }
    const instance = render(<Field job={job} onSettle={settle} />, {
      stdin: opts.stream as never,
      stdout: (opts.stdout ?? process.stdout) as never,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: opts.interactive ?? true,
    } as never)
    if (queued) queueMicrotask(() => settle(feed(job.scan, queued, {}) ?? job.scan.value))
  })
}

export const inkOnceEngine: InputEngine = {
  kind: 'ink-once',
  ask: (question, opts) => askInkOnce(question, opts ?? {}),
}

/**
 * Shape B — ONE Ink instance for a whole wizard, questions queued into it.
 *
 * This is the shape probe 3 exists to judge: it must never stack a second stdin listener, and it must
 * carry leftover bytes from one question to the next. The view is pure state — `current` is React state
 * — so answering question N and opening N+1 is one `setState`, not an imperative repaint.
 */
export class InkWizard {
  private readonly queue: Job[] = []
  private instance: ReturnType<typeof render> | null = null
  private view: ((current: Job | null) => void) | null = null
  private current: Job | null = null

  constructor(private readonly opts: InkOptions = {}) {}

  ask(question: string, opts: InkOptions = {}): Promise<string> {
    const job: Job = {
      question,
      hidden: isHidden({ ...this.opts, ...opts }),
      scan: newScan(),
      resolve: () => {},
      reject: () => {},
    }
    const p = new Promise<string>((resolve, reject) => { job.resolve = resolve; job.reject = reject })
    this.queue.push(job)
    this.start()
    this.drain()
    return p
  }

  private drain(): void {
    if (this.current || this.queue.length === 0) return
    const next = this.queue.shift()!
    this.current = next
    const carry = leftover.get(next)
    if (carry) {
      // Typed-ahead bytes answer this question; the rest of the chunk waits for the one after.
      const answer = feed(next.scan, carry, {})
      if (next.scan.answered) {
        if (next.scan.carry) leftover.set(next, next.scan.carry)
        else leftover.delete(next)
        this.finish(next, answer ?? next.scan.value)
        // Recursion via microtask keeps ordering predictable while React catches up.
        queueMicrotask(() => this.drain())
        return
      }
    }
    this.view?.(next)
  }

  private finish(job: Job, answer: string | Error): void {
    if (this.current === job) {
      this.current = null
      this.view?.(null)
    }
    if (job.hidden) (this.opts.stdout ?? process.stdout).write('\r\n')
    if (answer instanceof Error) job.reject(answer)
    else job.resolve(answer)
    queueMicrotask(() => this.drain())
  }

  start(): void {
    if (this.instance) return
    const owner = this
    function Wizard(): React.ReactElement {
      const [current, setCurrent] = useState<Job | null>(null)
      const [, tick] = useState(0)
      const app = useApp()
      useEffect(() => { owner.view = (job) => { setCurrent(job); tick((n) => n + 1) } }, [])
      usePaste((pasted) => {
        if (!current || current.scan.answered) return
        current.scan.value += pasted
        tick((n) => n + 1)
      })
      useInput((input, key) => {
        if (!current || current.scan.answered) return
        if (key.ctrl && key.name === 'c') {
          current.scan.cancelled = true
          current.scan.answered = true
          return owner.finish(current, new WizardCancelled('cancelled by user'))
        }
        const answer = feed(current.scan, input, {
          returned: input.length === 1 && key.return,
          eof: key.ctrl && key.name === 'd',
        })
        if (current.scan.answered) {
          if (current.scan.carry) leftover.set(current, current.scan.carry)
          return owner.finish(current, answer ?? current.scan.value)
        }
        tick((n) => n + 1)
      })
      return <Text>{current ? `${current.question}${current.hidden ? '' : current.scan.value}` : ''}</Text>
    }
    this.instance = render(<Wizard />, {
      stdin: this.opts.stream as never,
      stdout: (this.opts.stdout ?? process.stdout) as never,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: this.opts.interactive ?? true,
    } as never)
  }

  /** Probe 3: how many listeners the engine has put on the terminal so far. */
  observe(stream: ReadStream): { readable: number; data: number } {
    return { readable: stream.listenerCount('readable'), data: stream.listenerCount('data') }
  }

  stop(): void {
    this.instance?.unmount()
    this.instance = null
    this.view = null
  }

  get mounted(): boolean { return this.instance !== null }
}
