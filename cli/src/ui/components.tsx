/**
 * The component collection (#113) — plain typed exports, deliberately **not** Cordis plugins.
 *
 * Rationale, because "make the UI pluggable" is the kind of idea that deserves a written answer:
 * Cordis buys discovery, lifecycle and DI, which pay off where an implementation can be substituted.
 * A `Card` has nothing to substitute — its props are already its interface — and a string-keyed widget
 * registry would trade compile-time prop checking for runtime lookup, turning "does not typecheck" into
 * "renders nothing". #91 removed exactly that species of indirection (`SAIP_UI_ADMIN`, a guard with no
 * second implementation). The substitutable layer is `Renderer`, one level up.
 *
 * Every component here must render the same *content* as `plainRenderer`; that equivalence is asserted
 * per component in `tests/ui-components.test.ts`, not trusted.
 */
import React from 'react'
import { Box, Text } from 'ink'
import type { CardSpec } from '../lib/display.js'
import { PREFIX, type KvRow } from './blocks.js'

export function Card(props: { spec: CardSpec }): React.ReactElement {
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

export function KeyValues(props: { rows: KvRow[] }): React.ReactElement {
  // Same two rules the plain renderer follows, learned the hard way by running the binary in a pty:
  // an EMPTY label is a continuation row and must not print a bare colon (it renders as
  // `: gpu_memory_utilization=…`, which looks like a formatting artifact of a broken record), and the
  // value column is padded so the eye can scan it. Content is identical between renderers; only
  // spacing may differ, and padding is spacing, not content.
  const cell = (r: KvRow): string => (r.label ? `${r.label}: ` : '')
  const width = props.rows.reduce((m, r) => Math.max(m, cell(r).length), 0)
  return (
    <Box flexDirection="column">
      {props.rows.map((r, i) => (
        <Text key={`${r.label}-${i}`} wrap="wrap">
          <Text dimColor>{cell(r).padEnd(width)}</Text>
          {r.value}
          {r.hint ? <Text dimColor>{`   (${r.hint})`}</Text> : null}
        </Text>
      ))}
    </Box>
  )
}

export function Columns(props: { header: string[]; rows: string[][] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text>
        {props.header.map((h, i) => (i === 0 ? <Text key={h} bold>{h}</Text> : <Text key={h} bold>{`  ${h}`}</Text>))}
      </Text>
      {props.rows.map((r, ri) => (
        <Text key={`row${ri}`}>
          {r.map((c, i) => <Text key={`${ri}-${i}`}>{i === 0 ? c : `  ${c}`}</Text>)}
        </Text>
      ))}
    </Box>
  )
}

export function Rule(props: { width: number }): React.ReactElement {
  return <Text>{'─'.repeat(Math.max(1, props.width))}</Text>
}

export function Line(props: { text: string; level?: 'info' | 'warn' | 'error' }): React.ReactElement {
  const level = props.level ?? 'info'
  const color = level === 'error' ? 'red' : level === 'warn' ? 'yellow' : undefined
  return (
    <Text color={color} wrap="wrap">
      <Text dimColor>{`${PREFIX[level]} `}</Text>
      {props.text}
    </Text>
  )
}

export function List(props: { items: string[] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {props.items.map((item, i) => (
        <Text key={`${item}-${i}`} wrap="wrap">{`  ${item}`}</Text>
      ))}
    </Box>
  )
}

/** A continuation line: dimmer than the message it follows, and never carries the `[saip] ` marker. */
export function Note(props: { text: string }): React.ReactElement {
  return <Text dimColor wrap="wrap">{`   ${props.text}`}</Text>
}

export function Blank(): React.ReactElement {
  return <Text> </Text>
}
