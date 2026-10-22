/**
 * The card primitive and the terminal capability probe (#88, moved here from `lib/display.ts` when
 * `DisplayService` was retired in #106).
 *
 * These live in `ui/` because they are presentation, and the plain renderer is their only caller now
 * that commands go through `ctx.ui`. Keeping them under `lib/` next to a service that no longer exists
 * would leave a module named after a thing we deleted.
 */
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

