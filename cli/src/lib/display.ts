/**
 * DisplayService (#88) — renders the credential cards, with a fallback for every degraded
 * terminal.
 *
 * ## Why this is not Ink (measured, not preferred)
 * A spike against ink@5 + react@18 on this host produced:
 *   - 43 transitive packages, 19 MB node_modules for a static bordered block;
 *   - piped stdout is FINE — Ink emitted clean text, no cursor control sequences;
 *   - `TERM=dumb` is NOT fine: it still emitted box-drawing characters. Ink does not degrade for
 *     dumb terminals, so "degrades gracefully" would have had to be added on top of it;
 *   - bundling was then measured directly (esbuild 0.28.2): Ink+React bundles to 1,391,621 bytes
 *     and **does not run**. Without help it fails to resolve `react-devtools-core`; aliasing that
 *     devtools import to an empty shim makes it resolve but the output dies at runtime on
 *     `Dynamic require of "..." is not supported` — the CJS/ESM interop wall that is precisely what
 *     a Node SEA single-file binary (#71) cannot survive.
 * So Ink was rejected on measurements, not taste: 19 MB of dependencies for a static bordered
 * block, no degradation under TERM=dumb, and an unbundlable output. A hand-rolled renderer has no
 * dependencies, degrades deliberately, and cannot surprise #71.
 * The rejected alternative is recorded here so nobody re-litigates it from memory.
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
