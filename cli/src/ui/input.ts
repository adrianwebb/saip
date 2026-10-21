/**
 * The input seam (#106 slice 3).
 *
 * Commands ask the service for a value; which mechanism reads the terminal is a swappable choice,
 * exactly as with `Renderer`. That indirection is justified by a concrete second implementation
 * requirement rather than taste: the guarantees this CLI depends on — read `/dev/tty` and never stdin
 * because `--stdin` owns stdin (#73), bracketed paste so a pasted secret's newlines are content (#99),
 * `Ctrl+C` handled explicitly because raw mode disables `ISIG`, `\r\n` termination because raw mode has
 * no `OPOST`, leftover bytes carried to the next question, and an immediate refusal when there is no
 * controlling terminal — are properties of the *interaction*, and any engine (the tty reader today, an
 * Ink-driven one tomorrow, a web-console one later) has to satisfy the same test suite.
 *
 * An engine that cannot satisfy them is not a variant; it is a regression, and the gate suite says so.
 */
import type { ReadStream } from 'node:tty'
import { promptTTY } from './prompt.js'

export interface AskOptions {
  /** Hide the typing (a secret). Takes precedence over `echo`. */
  secret?: boolean
  /** Show the typing. Default is hidden unless `secret` says otherwise. */
  echo?: boolean
  /** Inject a stream: how the paste and Ctrl+C tests drive a prompt without a terminal. */
  stream?: ReadStream
}

export interface InputEngine {
  readonly kind: string
  ask(question: string, opts?: AskOptions): Promise<string>
}

/** The default: the tested `/dev/tty` reader that used to be a private helper of `config`. */
export const ttyEngine: InputEngine = {
  kind: 'tty',
  ask: (question, opts) => promptTTY(question, opts ?? {}),
}
