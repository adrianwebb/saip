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

export type Block =
  | { kind: 'card'; spec: CardSpec }
  | { kind: 'keyValues'; rows: KvRow[] }
  | { kind: 'columns'; header: string[]; rows: string[][] }
  | { kind: 'line'; text: string; level?: 'info' | 'warn' | 'error' }
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

/** `[saip] ` is a convention about *messages*, so it belongs to the line renderer alone. */
export const PREFIX: Record<NonNullable<Extract<Block, { kind: 'line' }>['level']>, string> = {
  info: '[saip]', warn: '[saip !]', error: '[saip x]',
}
