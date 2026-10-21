/**
 * A fake `tty.ReadStream` faithful to what Ink 8 actually calls (#154).
 *
 * The gate suite has to drive an Ink engine without a terminal, the same way `promptTTY`'s tests drive
 * the tty engine with a `PassThrough` — but a `PassThrough` is NOT enough for Ink, and knowing which
 * methods are load-bearing is the difference between a fake that exercises the engine and one that
 * silently disables it. Measured from `ink@8.0.0`:
 *
 * - `build/stream.js:2-5` — raw mode is granted only when `'isTTY' in stream && stream.isTTY === true`
 *   AND `typeof stream.setRawMode === 'function'`. A fake without `isTTY` makes `getRawModeStream`
 *   return `undefined`, `useInput` throws, and every probe would measure the failure of the fake.
 * - `build/components/App.js:226-230` — input is pulled, not pushed:
 *   `while ((chunk = stdin.read()) !== null)`, driven by an `'readable'` listener. So the fake must
 *   implement `read()` returning queued chunks, and emit `'readable'` when bytes arrive.
 * - `build/components/App.js:264`/`:146` — `ref?.()` on raw-mode enable, `unref?.()` on disable, so the
 *   event-loop behaviour under test (#151) needs both to exist.
 */
import { EventEmitter } from 'node:events'

export class FakeTTY extends EventEmitter {
  readonly isTTY = true
  readonly fd = 3
  columns = 80
  rows = 24
  isRaw = false
  /** Every `setRawMode` call, in order — the #73 "terminal restored" assertions read this. */
  readonly rawModeLog: boolean[] = []
  refCount = 0
  unrefCount = 0
  private readonly queue: Buffer[] = []
  private encoding: BufferEncoding = 'utf8'

  constructor(private readonly stdout?: { writes: string[] }) {
    super()
    // Node's ReadStream is an EventEmitter with these; Ink uses only what is implemented here.
    this.setMaxListeners(Infinity)
  }

  setRawMode(on: boolean): this {
    this.isRaw = on
    this.rawModeLog.push(on)
    return this
  }

  setEncoding(enc: BufferEncoding): this { this.encoding = enc; return this }
  resume(): this { return this }
  pause(): this { return this }
  ref(): this { this.refCount++; return this }
  unref(): this { this.unrefCount++; return this }

  /** Ink's pull loop: hand back the next queued chunk, or null when drained. */
  read(): Buffer | string | null {
    const next = this.queue.shift()
    if (!next) return null
    return this.encoding === 'buffer' ? next : next.toString(this.encoding)
  }

  /**
   * Deliver bytes as a terminal would, for BOTH consumer styles in this repo.
   *
   * Ink pulls: it listens for `'readable'` and drains `stdin.read()`
   * (`ink@8.0.0 build/components/App.js:226-230`). `promptTTY` pushes: it listens for `'data'`
   * (`src/ui/prompt.ts:159`). A fake that only did one of them would make the other engine look
   * broken — which is a property of the fake, not the engine. So both are emitted, and `read()`
   * will not hand back what a `'data'` listener already consumed.
   */
  feed(text: string | Buffer): void {
    const buf = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8')
    if (this.listenerCount('readable') > 0) this.queue.push(buf)
    if (this.listenerCount('data') > 0) this.emit('data', buf)
    if (this.listenerCount('readable') > 0) this.emit('readable')
  }

  /** Feed with a deliberate gap, so a multi-chunk paste is split like a real one. */
  async feedSplit(text: string, gapMs = 5): Promise<void> {
    const mid = Math.ceil(text.length / 2)
    this.feed(text.slice(0, mid))
    await new Promise((r) => setTimeout(r, gapMs))
    this.feed(text.slice(mid))
  }

  destroy(): void { this.emit('close'); this.emit('end') }
  override on(event: 'readable', listener: () => void): this
  override on(event: string, listener: (...args: any[]) => void): this
  override on(event: string, listener: (...args: any[]) => void): this { return super.on(event, listener) }
}

/** A collecting stdout that still looks like a TTY, so Ink takes its interactive path. */
export function fakeStdout(columns = 80): NodeJS.WriteStream & { writes: string[] } {
  const writes: string[] = []
  const stream = new EventEmitter() as unknown as NodeJS.WriteStream & { writes: string[] }
  Object.assign(stream, {
    isTTY: true,
    columns,
    rows: 24,
    encoding: 'utf8',
    fd: 1,
    writes,
    write: (chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    },
    cork: () => {},
    uncork: () => {},
    destroy: () => {},
    once: (e: string, l: () => void) => stream.on(e, l),
  })
  return stream
}

/** Join a collecting stdout's writes into one string. */
export function textOf(stdout: { writes: string[] }): string { return stdout.writes.join('') }
