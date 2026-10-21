/**
 * Plain renderer (#113): the fallback that pipes, CI, agents and log collectors get, and the one that
 * must never contain box-drawing or ANSI. The card implementation is #88's `renderCard`, reused rather
 * than reimplemented — two plain renderers would drift exactly like two command-local formatters did.
 */
import { renderCard } from '../lib/display.js'
import { PREFIX, type Block, type KvRow } from './blocks.js'
import type { Renderer } from './renderer.js'


export const plainRenderer: Renderer = {
  kind: 'plain',
  renderAll: (blocks: Block[]): string => blocks.map((b) => plainRenderer.render(b)).join('\n'),
  render(block: Block): string {
    switch (block.kind) {
      case 'card':
        // unicode:false keeps this path ASCII-only regardless of locale: a log collector is not a
        // terminal, and #88 measured that box characters break greppability.
        return renderCard(block.spec, { unicode: false, color: false, columns: 80 })
      case 'keyValues': {
        // `label:` with the colon inside the padded field, so `Adapters:  3 defined` stays matchable
        // by `grep 'Adapters:'` — the property that makes this output usable in logs and CI.
        const cell = (r: KvRow): string => (r.label ? `${r.label}: ` : '')
        const w = block.rows.reduce((m, r) => Math.max(m, cell(r).length), 0)
        return block.rows
          .map((r) => `  ${cell(r).padEnd(w)}${r.value}${r.hint ? `   (${r.hint})` : ''}`)
          .join('\n')
      }
      case 'columns': {
        const widths = block.header.map((h, i) =>
          Math.max(h.length, ...block.rows.map((r) => (r[i] ?? '').length)))
        const row = (cells: string[]): string =>
          `  ${cells.map((c, i) => (i === 0 ? c : c.padStart(widths[i]))).join('  ')}`
        // Header cells are padded like the rest so column alignment survives any label length.
        return [row(block.header.map((h, i) => (i === 0 ? h : h.padStart(widths[i]))).slice()),
          ...block.rows.map((r) => row(block.header.map((_, i) => r[i] ?? '')))].join('\n')
      }
      case 'line': {
        const level = block.level ?? 'info'
        return `${PREFIX[level]} ${block.text}`
      }
      case 'list':
        // Names with optional annotations, indented and unprefixed: this is a listing, not a message.
        return block.items.map((i) => `  ${i}`).join('\n')
      case 'note':
        // Continuation of the message above it, so it carries no `[saip] ` marker.
        return `   ${block.text}`
      case 'blank':
        return ''
      case 'raw':
        // Verbatim: the wizard's own wording, prefix and indentation included.
        return block.lines.join('\n')
      case 'rule':
        return '-'.repeat(Math.max(1, block.width))
    }
  },
}
