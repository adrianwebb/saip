import { PASTE, PASTE_END, runProbe, type ProbeCase } from './probe-driver.js'
import { isolatedEnv } from '../support/pty.js'

const env = isolatedEnv()

const cases: ProbeCase[] = [
  // 1 — termination, visible engine
  { id: 'P1-once-visible', args: ['--probe=1', '--engine=once'], keys: [{ after: 'SAIP_R2_BUCKET', text: 'mybucket\r' }] },
  // 1 — termination, hidden engine
  { id: 'P1-once-hidden', args: ['--probe=1', '--engine=once', '--secret=1'], keys: [{ after: 'SAIP_R2_BUCKET', text: 'hunter2\r' }] },
  // 2 — ordering, visible
  { id: 'P2-order-visible', args: ['--probe=2', '--engine=once'], keys: [{ after: 'EXPLAIN-TWO', text: 'bucket-name\r' }] },
  // 2 — ordering, hidden
  { id: 'P2-order-hidden', args: ['--probe=2h', '--engine=once'], keys: [{ after: 'EXPLAIN-ONE', text: 'pass\r' }] },
  // 3 — two questions, one chunk typed ahead
  { id: 'P3-once-ahead', args: ['--probe=3', '--engine=once'], keys: [{ after: 'SAIP_R2_BUCKET', text: 'one\rtwo\r' }] },
  { id: 'P3-wizard-ahead', args: ['--probe=3', '--engine=wizard'], keys: [{ after: 'SAIP_R2_BUCKET', text: 'one\rtwo\r' }] },
  // 4 — paste with an embedded newline, then the real Enter
  { id: 'P4-paste-newline', args: ['--probe=4', '--engine=once'], keys: [{ after: 'SECRET_ACCESS_KEY', text: `${PASTE}very-long-secret-value\n${PASTE_END}` }, { delayMs: 60, text: '\r' }] },
  // 4 — Ctrl+D as EOF
  { id: 'P4-ctrl-d', args: ['--probe=4', '--engine=once', '--mode=ctrld'], keys: [{ after: 'SAIP_R2_BUCKET', text: 'value-then-eof\x04' }] },
  // 4 — Ctrl+C cancels
  { id: 'P4-ctrl-c', args: ['--probe=4', '--engine=once', '--mode=cancel'], keys: [{ after: 'SAIP_R2_BUCKET', text: 'partial\x03' }] },
  // 5 — listener counts across a long-lived wizard
  { id: 'P5-wizard-listeners', args: ['--probe=5', '--engine=wizard'], keys: [{ after: 'Q1', text: 'a\r' }, { after: 'Q2', text: 'b\r' }, { after: 'Q3', text: 'c\r' }, { after: 'Q4', text: 'd\r' }] },
]

for (const c of cases) {
  const e = await runProbe(c, env)
  console.log(`\n########## ${c.id} ##########`)
  console.log(`code=${e.result.code} signal=${e.result.signal} hung=${e.result.hung} clean=${e.result.clean} killed=${e.result.killedBySignal} elapsed=${e.result.elapsedMs}ms`)
  console.log('--- SCREEN ROWS ---')
  e.screenRows.forEach((r, i) => console.log(`  ${i}| ${r}`))
  console.log('--- STATE MARKERS ---')
  for (const line of e.result.raw.split('\n')) if (line.startsWith('STATE[') || line.startsWith('ANSWERED') || line.startsWith('CANCELLED') || line.startsWith('ERROR') || line.startsWith('LEN=')) console.log('  ' + line.trim())
  if (e.unparsed.length) console.log('--- UNPARSED (model gap!) --- ' + JSON.stringify(e.unparsed.slice(0, 8)))
  if (/rawMode|isRaw=true/.test(e.result.raw)) console.log('  note: raw mode reported on')
}

// #87 asks bucket/endpoint with echo ON; the value must be readable ON the prompt line.
// Typed char-by-char (human pace) vs one chunk (script/paste) — the two can differ under a throttled
// live renderer, and only the terminal shows which.
const echoCases: ProbeCase[] = [
  { id: 'P6-echo-typed', args: ['--probe=1', '--engine=once'], keys: [
    { after: 'SAIP_R2_BUCKET', text: 'mybucket' }, { delayMs: 120, text: '\r' }] },
  { id: 'P6-echo-paste', args: ['--probe=1', '--engine=once'], keys: [
    { after: 'SAIP_R2_BUCKET', text: `${PASTE}mybucket${PASTE_END}` }, { delayMs: 120, text: '\r' }] },
  { id: 'P6-echo-chunk', args: ['--probe=1', '--engine=once'], keys: [{ after: 'SAIP_R2_BUCKET', text: 'mybucket\r' }] },
  { id: 'P6-wizard-echo', args: ['--probe=3', '--engine=wizard'], keys: [
    { after: 'SAIP_R2_BUCKET', text: 'vis-bucket' }, { delayMs: 150, text: '\r' }, { after: 'SAIP_R2_ENDPOINT', text: 'https://ep' }, { delayMs: 150, text: '\r' }] },
]
for (const c of echoCases) {
  const e = await runProbe(c, env)
  console.log(`\n########## ${c.id} ##########`)
  console.log(`code=${e.result.code} hung=${e.result.hung}`)
  console.log('--- SCREEN ROWS ---')
  e.screenRows.forEach((r, i) => console.log(`  ${i}| ${r}`))
  if (e.unparsed.length) console.log('--- UNPARSED --- ' + JSON.stringify(e.unparsed.slice(0, 6)))
}
