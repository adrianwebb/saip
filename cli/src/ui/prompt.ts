/**
 * The terminal input engine (#73, #99, #86) — moved out of `commands/config.ts` so it sits behind the
 * `ui` seam (#106 slice 3) instead of being a private helper of one command.
 *
 * Everything here encodes a behaviour that cost a bug report: reading the controlling terminal rather
 * than stdin (because `--stdin` owns stdin), bracketed paste so a clipboard value's own newlines are
 * content, `Ctrl+C` handled explicitly because raw mode disables `ISIG`, `\r\n` termination because
 * raw mode has no `OPOST`, and leftover bytes carried to the next question so an over-eager paste
 * cannot answer two prompts. Any replacement engine — including an Ink-based one — must pass the same
 * tests, which is why the engine is selected behind the seam rather than called directly.
 */
import { openSync } from 'node:fs'
// tty.ReadStream, not fs.ReadStream: only the tty one carries isRaw/setRawMode, which the
// hidden-input path depends on (#73).
import { ReadStream } from 'node:tty'
import { WizardCancelled } from '../commands/config-init.js'
export class NoTerminalError extends Error { readonly name = 'NoTerminalError' }

/**
 * Read a secret from the controlling terminal, not from stdin.
 *
 * This matters because the documented zero-friction path is `printf x | saip config set NAME
 * --stdin`: the pipe supplies the value, so a passphrase prompt that read stdin would get
 * nothing and silently store an empty passphrase. `sudo` and `ssh-add` avoid this by using
 * /dev/tty; so do we — and with no controlling terminal we refuse outright rather than storing
 * a key that nobody knows, which would look like success and be unrecoverable.
 */
/**
 * One stream for the controlling terminal, opened once and reused — so bytes typed ahead of the
 * next prompt survive in `pending` rather than being lost with a closed fd (#99).
 *
 * Reusing it, however, is what made every prompted command hang: an active ReadStream keeps the
 * event loop alive, so `config set NAME` printed `stored …` and then sat in `ep_poll` with the tty
 * fd open until the user killed it (#110 F1). The handle is therefore **unref'd between prompts and
 * ref'd during one**: it stops holding the process open, while still existing so buffered leftovers
 * and the open fd survive from one question to the next.
 */
let ttyStream: ReadStream | undefined
function holdTty(stream: ReadStream, hold: boolean): void {
  // Node exposes ref/unref on fd-backed streams, but the type is on WriteStream; guard rather than
  // assume, because an injected test stream has neither.
  const fn = hold ? (stream as unknown as { ref?: () => void }).ref : (stream as unknown as { unref?: () => void }).unref
  if (typeof fn === 'function') { try { fn.call(stream) } catch { /* a fake stream in tests */ } }
}

export function ttyInput(): ReadStream {
  if (ttyStream) return ttyStream
  let fd: number
  try { fd = openSync('/dev/tty', 'r+') }
  catch { throw new NoTerminalError('no controlling terminal to prompt on; set SAIP_SECRETS_PASSPHRASE, or run `saip config key add unattended` once a passphrase store exists') }
  ttyStream = new ReadStream(fd)
  // Unref'd at creation: opening the terminal must not by itself keep a non-prompting command alive.
  holdTty(ttyStream, false)
  return ttyStream
}

/**
 * Bytes that arrived but were not consumed by the previous prompt.
 *
 * This is the fix for a paste that appears to lock the wizard up. A clipboard value usually carries
 * its own trailing newline, so the terminal delivers `value\r` — sometimes several lines at once —
 * in a SINGLE chunk. The first newline ended the prompt and everything after it was previously
 * discarded along with the stream, so the next prompt waited for input that had already arrived and
 * the program looked hung. Retaining the remainder is also what makes scripted input work at all.
 */
const pending = new WeakMap<NodeJS.ReadableStream, string>()

/**
 * Read one line from the terminal.
 *
 * `secret: true` suppresses echo. Doing that requires raw mode, which also turns off `OPOST`, so the
 * terminal will not expand a lone `\n` into carriage-return + line-feed. The old code wrote a bare
 * `\n`, and the cursor walked down to the *same column* where the prompt ended — the "cursor on the
 * line after the variable name" artifact. In raw mode we therefore terminate with `\r\n`, and when
 * echo is on we write nothing, because the terminal already advanced.
 *
 * Bracketed paste mode is enabled while hidden input is expected so a pasted secret's embedded
 * newline is content rather than an accidental submission. Terminals that ignore the sequence still
 * behave, because callers strip trailing newlines.
 */
export function promptTTY(
  question: string,
  opts: { echo?: boolean; secret?: boolean; stream?: ReadStream } = {},
): Promise<string> {
  const hidden = opts.secret ?? (opts.echo === undefined ? true : !opts.echo)
  const stream = opts.stream ?? ttyInput()
  const wasRaw = stream.isRaw
  if (hidden) { try { stream.setRawMode(true) } catch { /* injected stream in tests */ } }
  // Ask the terminal for bracketed paste so a clipboard value's own newlines are content rather
  // than accidental submissions. Older terminals ignore the sequence, which is why a secret
  // containing newlines is better piped — the prompt says so instead of failing quietly.
  if (hidden) process.stdout.write('\u001b[?2004h')
  process.stdout.write(question)

  let value = ''
  let inPaste = false
  let csi = ''                 // CSI parameter bytes, to recognise the paste markers
  // ECMA-48: `ESC [` is a two-byte introducer, and only then do parameter bytes begin. Collapsing
  // this into "ESC then final byte" made `[` itself look final, so a bracketed-paste marker's
  // digits and `~` were treated as typed characters and leaked into the value.
  let escState: 'none' | 'introducer' | 'params' = 'none'

  return new Promise((resolve, reject) => {
    const carryFrom = (text: string, index: number): void => {
      const rest = text.slice(index + 1)
      if (rest) pending.set(stream, (pending.get(stream) ?? '') + rest)
    }
    const cleanup = (): void => {
      // Release the loop between prompts; `pending` keeps whatever the user typed ahead.
      holdTty(stream, false)
      if (hidden) { try { stream.setRawMode(!!wasRaw) } catch { /* not a real tty */ } }
      if (hidden) process.stdout.write('\u001b[?2004l')     // leave the terminal as we found it
      stream.removeListener('data', onData)
      stream.removeListener('error', onError)
    }
    const finish = (): void => {
      cleanup()
      // Raw mode has no OPOST, so the line break must carry its own carriage return. A bare \n
      // leaves the cursor under the middle of the prompt — the "cursor on the next line" artifact.
      if (hidden) process.stdout.write('\r\n')
      resolve(value)
    }
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        const code = ch.codePointAt(0) ?? 0
        if (escState === 'introducer') {
          escState = ch === '[' ? 'params' : 'none'   // other escapes: swallow their next byte
          continue
        }
        if (escState === 'params') {
          if (code >= 0x30 && code <= 0x3f) { csi += ch; continue }
          escState = 'none'
          if (ch === '~' && csi === '200') { inPaste = true; csi = ''; continue }
          if (ch === '~' && csi === '201') { inPaste = false; csi = ''; continue }
          csi = ''
          continue
        }
        if (code === 0x1b) { escState = 'introducer'; csi = ''; continue }
        if (ch === '\n' || ch === '\r') {
          if (inPaste) { value += '\n'; continue }        // pasted newline is content
          carryFrom(text, i)
          return finish()
        }
        if (code === 0x04) { carryFrom(text, i); return finish() }          // Ctrl+D = EOF
        if (code === 0x03) {                                            // Ctrl+C
          value = ''; pending.delete(stream); inPaste = false
          cleanup()
          return reject(new WizardCancelled('cancelled by user'))
        }
        if (code === 0x7f || code === 0x08) { value = value.slice(0, -1); continue }
        if (code < 0x20) continue                                            // never store control bytes
        value += ch
      }
    }
    const onError = (): void => { cleanup(); reject(new WizardCancelled('terminal closed')) }
    holdTty(stream, true)          // hold the loop only while a question is actually open
    stream.on('data', onData)
    stream.once('error', onError)
    const queued = pending.get(stream)
    if (queued) {
      pending.delete(stream)
      // A clipboard value often carries a trailing blank line, and that newline used to submit the
      // NEXT prompt empty — a required secret reported as "left empty" that the user never typed
      // into. Leftover text that contains a real character is typed-ahead input and must survive;
      // a remainder made only of line terminators is the tail of the previous paste, and is dropped.
      if (/^[\r\n\u0004]+$/.test(queued)) {
        /* discarded */
      } else {
        queueMicrotask(() => onData(Buffer.from(queued, 'utf8')))
      }
    }
  })
}
