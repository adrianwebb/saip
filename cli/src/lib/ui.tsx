/**
 * `ui` — the terminal presentation seam (#106).
 *
 * Why a seam at all: SAIP's hand-rolled terminal code produced five bug reports in one session
 * (prompt-before-explanation twice, paste lockup, cursor on the wrong line, leftover input
 * shifting answers). The maintainer's call was to build on a maintained TUI framework rather than
 * keep re-fixing the same layer, and to do it while exactly one screen uses it.
 *
 * Two renderers, chosen by what the attached stream can do — never by a flag a user has to know:
 *
 *   ink     a real TTY: widgets, redraws, cursor handling, the shared vocabulary later screens use
 *   plain   pipes, CI, agents, log capture: `label: value` lines
 *
 * The plain renderer is not a courtesy. Measured on the Ink spike (#88/#103): a **compiled** Ink
 * binary writes nothing at all to a pipe, and Ink does not degrade under `TERM=dumb`. So selection
 * has to live somewhere, and "somewhere" is this service.
 *
 * Staging of the migration, so no PR is both a refactor and a behaviour change: this commit adds the
 * service and registers it; screens keep using `DisplayService` until each is moved deliberately, and
 * the hand-rolled box renderer is deleted only after the last of them passes on Ink.
 */
import { Service, type Context } from 'cordis'
import React from 'react'
import { Box, Text, render, type RenderOptions } from 'ink'
import { detectDisplay, renderCard, type CardSpec, type DisplayOptions } from './display.js'

declare module 'cordis' {
  interface Context { ui?: UiService }
}

export const UI_SERVICE = 'ui'
export type UiMode = 'ink' | 'plain'

/** Capability test, kept separate so it can be asserted without a terminal. */
export function chooseMode(env: NodeJS.ProcessEnv = process.env, isTTY = false, inkEnabled = true): UiMode {
  const d = detectDisplay(env, isTTY)
  // detectDisplay already encodes "UTF-8 locale and not TERM=dumb" as `unicode`; Ink's box drawing
  // is exactly the thing that assumption protects.
  if (!isTTY || !d.unicode) return 'plain'
  return inkEnabled ? 'ink' : 'plain'
}

/** A card in Ink. One row per field, label in bold, value wrapped by Ink itself. */
export function CardView(props: { spec: CardSpec }): React.ReactElement {
  const { spec } = props
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} borderDimColor>
      <Text bold wrap="truncate">
        {spec.badge ? `${spec.title}  (${spec.badge})` : spec.title}
      </Text>
      {spec.fields.map((f) => (
        <Text key={f.label} wrap="wrap">
          <Text dimColor>{`${f.label}: `}</Text>
          {f.value}
        </Text>
      ))}
    </Box>
  )
}

/**
 * Render an element to a string.
 *
 * Ink writes frames to whatever stream it is handed, so a collecting fake is enough — and doing it
 * this way is what lets the ink path be *tested* rather than only observed by a human at a
 * terminal. Non-TTY here is deliberate: it is also the case where a real Ink process is expected to
 * produce nothing, so a test that captures frames proves the component itself is sound separately
 * from that runtime behaviour.
 */
export function renderInkToString(el: React.ReactElement, columns = 80): string {
  const written: string[] = []
  const stdout = {
    write: (s: string | Uint8Array) => { written.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8')); return true },
    columns,
    isTTY: false as const,
    setEncoding: () => stdout,
    on: () => stdout, once: () => stdout, off: () => stdout, removeListener: () => stdout,
    emit: () => false,
    // Ink asks for a raw-mode capable stdin; without a TTY it must not be asked to hide a cursor.
  }
  const stdin = {
    isTTY: false as const, setRawMode: () => stdin, setEncoding: () => stdin, resume: () => stdin, pause: () => stdin,
    on: () => stdin, once: () => stdin, off: () => stdin, removeListener: () => stdin, emit: () => false,
    read: () => null,
  }
  const options = { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false } as unknown as RenderOptions
  const instance = render(el, options)
  const frame = written.join('')
  try { instance.unmount() } catch { /* teardown of a synthetic render must never throw outward */ }
  return frame
}

export interface UiConfig { env?: NodeJS.ProcessEnv; isTTY?: boolean; ink?: boolean }

export class UiService extends Service {
  static readonly provide = UI_SERVICE
  readonly mode: UiMode
  readonly display: DisplayOptions

  constructor(ctx: Context, config: UiConfig = {}) {
    super(ctx, UI_SERVICE)
    const isTTY = config.isTTY ?? Boolean(process.stdout.isTTY)
    this.mode = chooseMode(config.env ?? process.env, isTTY, config.ink ?? true)
    this.display = detectDisplay(config.env ?? process.env, isTTY)
  }

  /** A card, rendered by whichever engine this stream gets. */
  card(spec: CardSpec): string {
    if (this.mode === 'ink') {
      return renderInkToString(<CardView spec={spec} />, this.display.columns)
    }
    // Deferred import would dodge the whole module graph; keep it static so a missing dependency is
    // a build failure rather than a runtime surprise in the plain path.
    return plainCard(spec, this.display)
  }

  show(spec: CardSpec): void { process.stdout.write(`${this.card(spec)}\n`) }
}

/**
 * Plain card. `display.ts` already owns width/clamp/unicode-vs-ascii behaviour and is what the
 * existing screens render through, so the plain path here calls it rather than growing a second
 * implementation to drift. (An earlier draft of this file wrapped the call in an indirection that
 * claimed to avoid an import cycle; there is no cycle, and the wrapper was dead cleverness.)
 */
function plainCard(spec: CardSpec, opts: DisplayOptions): string {
  return renderCard(spec, opts)
}
