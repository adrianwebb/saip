/**
 * DisplayService (#88) — renders the credential cards, with a fallback for every degraded
 * terminal.
 *
 * ## Ink: an earlier version of this section was wrong — re-measure before trusting it
 *
 * This header once declared Ink un-bundlable and treated that as settled guidance. It was wrong in
 * its general form, and the reason matters more than the conclusion: every failure came from my own
 * configuration. Recorded with the setup attached, per AGENTS.md "Web Research", because a negative
 * result without its configuration is an anecdote.
 *
 *   - **Plain Node, unbundled: Ink works.** `node inkcard.mjs` renders the card, and does so into a
 *     pipe as well (737 bytes, ink@8.0.0; 907 bytes, ink@5.2.1) with no cursor control sequences.
 *     "Can Ink run here" was never the question.
 *   - **esbuild: fails.** 1,391,621-byte bundle; unresolved `react-devtools-core`; aliasing it to a
 *     stub still dies at runtime on `Dynamic require of "..." is not supported`. This result stands
 *     for esbuild specifically.
 *   - **Bun: works once the optional peer is installed.** `bun build --compile` with
 *     `react-devtools-core` present produced a 92,686,304-byte binary (544 modules) that rendered
 *     correctly when run under a pty. Without it: `Could not resolve: "react-devtools-core"` — which
 *     is exactly what I mistook for a fundamental limit. `--external` compiles but fails at runtime
 *     (`Cannot find package` from `/$bunfs/root/...`, since externals are not in the virtual
 *     filesystem); `--alias` did not resolve either. My second theory, an Ink 6.8.0 tree-shaking
 *     regression, was also wrong: 6.7.0 failed identically.
 *   - Marginal cost under Bun is ~0.7 MB (91.97 -> 92.69 MB) because the embedded runtime dominates,
 *     so with Bun as the packager (#71) Ink is cheap rather than disqualified.
 *   - **`TERM=dumb`: Ink does not degrade** — box-drawing characters are emitted regardless (checked
 *     again after the correction, both unbundled and compiled).
 *   - **The compiled Bun binary writes nothing to a pipe** (exit 0, empty output) while plain Node
 *     does. So this is a property of that artifact, not of Ink: do not repeat it as "Ink cannot
 *     produce output when piped", which is the mistake this bullet exists to prevent.
 *
 * The hand-rolled renderer still ships, but on a weaker and more honest basis: zero dependencies,
 * identical behaviour in all of the above environments, and an explicit plain-text path for non-TTY
 * output. If #71 lands on Bun, Ink for the interactive case with this as the fallback is a live
 * proposal, and this paragraph must be re-measured rather than copied forward.
 *
 */
import { Service, type Context } from 'cordis'

declare module 'cordis' {
  interface Context { display?: DisplayService }
}

export interface CardField { label: string; value: string; muted?: boolean }
export interface CardSpec { title: string; badge?: 'required' | 'optional' | 'retired'; fields: CardField[] }

export interface DisplayOptions { columns?: number; unicode?: boolean; color?: boolean }

/** UTF-8 capable locale, or not. `TERM=dumb` and the C/POSIX locales get ASCII boxes. */
export function detectDisplay(env: NodeJS.ProcessEnv = process.env, isTTY = true): DisplayOptions {
  const lang = `${env.LC_ALL ?? ''}${env.LC_CTYPE ?? ''}${env.LANG ?? ''}`
  const unicode = /UTF-?8/i.test(lang) && env.TERM !== 'dumb'
  const color = isTTY && !env.NO_COLOR && env.TERM !== 'dumb' && env.TERM !== 'linux'
  const raw = Number(process.stdout?.columns ?? env.COLUMNS ?? 80)
  return { columns: Number.isFinite(raw) && raw > 0 ? Math.min(raw, 100) : 80, unicode, color }
}

const BOX = {
  unicode: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  ascii: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' },
}

/** One card. Width-aware: below the threshold, field values stack under their labels. */
export function renderCard(spec: CardSpec, opts: DisplayOptions = {}): string {
  const { columns = 80, unicode = true, color = false } = opts
  const b = unicode ? BOX.unicode : BOX.ascii
  const inner = Math.max(20, columns - 4)
  const stacked = columns < 72

  const title = spec.badge ? `${spec.title}  (${spec.badge})` : spec.title
  const wrap = (text: string, width: number): string[] => {
    if (text.length <= width) return [text]
    const words = text.split(/\s+/); const out: string[] = []; let line = ''
    for (const w of words) {
      if ((line + ' ' + w).trim().length > width) { if (line) out.push(line.trim()); line = w }
      else line = `${line} ${w}`
    }
    if (line.trim()) out.push(line.trim())
    return out.length ? out : ['']
  }

  const paint = (text: string, kind: 'frame' | 'label' | 'plain'): string => {
    if (!color || kind === 'plain') return text
    // ANSI only when a colour-capable TTY was detected; never when piped or dumb.
    return kind === 'frame' ? `\x1b[36m${text}\x1b[0m` : `\x1b[1m${text}\x1b[0m`
  }

  const lines: string[] = [paint(`${b.tl}${b.h.repeat(inner - 1)}${b.tr}`, 'frame')]
  const pushText = (text: string, kind: 'frame' | 'label' | 'plain' = 'plain'): void => {
    for (const l of wrap(text, inner)) lines.push(paint(`${b.v} ${l.padEnd(inner - 1)}${b.v}`, kind))
  }
  pushText(title, 'label')
  for (const f of spec.fields) {
    if (stacked) {
      pushText(`${f.label}:`)
      for (const l of wrap(f.value, inner - 2)) pushText(`  ${l}`)
    } else {
      pushText(`${f.label}: ${f.value}`)
    }
  }
  lines.push(paint(`${b.bl}${b.h.repeat(inner - 1)}${b.br}`, 'frame'))
  return lines.join('\n')
}

export const DISPLAY_SERVICE = 'display'

/** Cordis plugin: commands render through it and contain no formatting logic of their own. */
export class DisplayService extends Service {
  static readonly provide = DISPLAY_SERVICE
  readonly options: DisplayOptions
  private readonly out: (line: string) => void

  constructor(ctx: any, config: { env?: NodeJS.ProcessEnv; write?: (line: string) => void; isTTY?: boolean } = {}) {
    super(ctx, DISPLAY_SERVICE)
    const isTTY = config.isTTY ?? Boolean(process.stdout.isTTY)
    this.options = detectDisplay(config.env ?? process.env, isTTY)
    // When not a TTY the frame is emitted as plain "label: value" lines: greppable, diff-friendly,
    // and no box characters for a log collector to choke on.
    this.out = config.write ?? ((line: string) => process.stdout.write(`${line}\n`))
  }

  get plain(): boolean { return !process.stdout.isTTY }

  card(spec: CardSpec): string {
    if (this.plain) {
      const head = spec.badge ? `${spec.title} (${spec.badge})` : spec.title
      return [head, ...spec.fields.map((f) => `  ${f.label}: ${f.value}`)].join('\n')
    }
    return renderCard(spec, this.options)
  }

  show(spec: CardSpec): void { for (const line of this.card(spec).split('\n')) this.out(line) }
}
