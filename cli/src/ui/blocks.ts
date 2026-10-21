/**
 * The block model (#113) — one source of truth for UI **content**, shared by every renderer.
 *
 * Why this exists: `status`, `profiles`, `doctor` and the wizard each formatted the same ideas
 * themselves (a `[saip] ` message, aligned `key: value` rows, padded columns, a horizontal rule).
 * Two renderers plus per-command formatting means three places where a field can go missing, and the
 * missing-field case is invisible to tests that only look at one of them. Blocks are data; renderers
 * decide presentation; commands construct blocks. That is the whole abstraction — no registry, no
 * runtime lookup, everything still typechecks.
 */
import type { CardSpec } from '../lib/display.js'

/**
 * The block vocabulary a command can express. `note`, `blank` and `list` were added when migrating
 * `config`/`ssh` output, because their real output needs them: a prefixed message, an indented
 * continuation, a spacer, and a set of names with annotations. Without those, a command would keep
 * hand-building strings and the seam would be decorative rather than load-bearing.
 */
export type Block =
  | { kind: 'card'; spec: CardSpec }
  | { kind: 'keyValues'; rows: KvRow[] }
  | { kind: 'columns'; header: string[]; rows: string[][] }
  | { kind: 'list'; items: string[] }
  | { kind: 'line'; text: string; level?: 'info' | 'warn' | 'error'; data?: Record<string, unknown> }
  | { kind: 'note'; text: string }
  | { kind: 'blank' }
  | { kind: 'rule'; width: number }

export interface KvRow { label: string; value: string; hint?: string }

/** `badge` is CardSpec's union, not a free string — the three states are a domain rule (#93). */
export type CardBadge = NonNullable<CardSpec['badge']>

export const cardBlock = (title: string, badge: CardBadge | undefined, fields: { label: string; value: string }[]): Block =>
  ({ kind: 'card', spec: { title, badge, fields } })

export const kvBlock = (rows: KvRow[]): Block => ({ kind: 'keyValues', rows })
export const columnsBlock = (header: string[], rows: string[][]): Block => ({ kind: 'columns', header, rows })
export const lineBlock = (text: string, level: 'info' | 'warn' | 'error' = 'info'): Block => ({ kind: 'line', text, level })
export const ruleBlock = (width = 60): Block => ({ kind: 'rule', width })
export const listBlock = (items: string[]): Block => ({ kind: 'list', items })
export const noteBlock = (text: string): Block => ({ kind: 'note', text })
export const blankBlock = (): Block => ({ kind: 'blank' })

/**
 * The marker is `[saip]` for every severity. The codebase already says `[saip] error: …` and
 * `[saip] WARNING: …` — severity is carried by the `level` field (which the Ink renderer turns into
 * colour and the JSONL renderer into data), NOT by mutating the prefix. An earlier revision of this
 * file invented `[saip !]` / `[saip x]`, which would have made the seam disagree with every existing
 * line of output for no benefit.
 */
export const PREFIX: Record<NonNullable<Extract<Block, { kind: 'line' }>['level']>, string> = {
  info: '[saip]', warn: '[saip]', error: '[saip]',
}
