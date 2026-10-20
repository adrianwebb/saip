/**
 * JSON renderer (#113) — the proof that the `Renderer` seam is worth having.
 *
 * The maintainer's point: `--json` must bypass Ink on *every* command, because agents and scripts are
 * a first-class audience for this CLI. Doing that per command is what we already have with
 * `profiles --json`, `ssh --json`, `status`… each hand-rolling its own object, which is the same
 * divergence #87/#93 fixed for secret values. Because commands build **blocks**, a machine target is
 * one registration away and needs no command changes: the data is already separated from presentation.
 *
 * NDJSON: one object per block, so a long-lived command streams records instead of producing one giant
 * document that cannot be parsed until it exits. `kind` is preserved so a consumer can dispatch.
 */
import type { Block } from './blocks.js'
import type { Renderer } from './renderer.js'

export const jsonlRenderer: Renderer = {
  kind: 'jsonl',
  render(block: Block): string {
    switch (block.kind) {
      case 'card':
        return JSON.stringify({ kind: 'card', title: block.spec.title, badge: block.spec.badge, fields: block.spec.fields })
      case 'keyValues':
        return JSON.stringify({ kind: 'keyValues', rows: block.rows.map((r) => ({ label: r.label, value: r.value, hint: r.hint })) })
      case 'columns':
        return JSON.stringify({ kind: 'columns', header: block.header, rows: block.rows })
      case 'line':
        return JSON.stringify({
          // The `[saip] ` marker is presentation, so it is dropped here rather than leaking into a
          // machine value (the blemish #113 noted: an Error message rendered as a record still carried
          // its prefix). `level` already encodes what the marker was for.
          kind: 'line', level: block.level ?? 'info', text: block.text.replace(/^\[saip(?: [!x])?\]\s*/, ''),
          // A structured payload is optional metadata; `text` stays so a consumer never has to guess
          // whether a record carries a code.
          ...(block.data ? { data: block.data } : {}),
        })
      case 'rule':
        // A rule is decoration. It still gets a record rather than being silently dropped, so a
        // consumer sees the same block sequence the terminal saw.
        return JSON.stringify({ kind: 'rule', width: block.width })
    }
  },
}
