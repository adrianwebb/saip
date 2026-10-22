import { runProbe, type ProbeCase } from './probe-driver.js'
import { isolatedEnv } from '../support/pty.js'

const env = isolatedEnv()
const cases: ProbeCase[] = [
  { id: 'CTRL-tty', args: ['--probe=1', '--engine=tty'], keys: [{ after: 'SAIP_R2_BUCKET', text: 'plain-tty\r' }] },
  { id: 'CTRL-tty-hidden', args: ['--probe=1', '--engine=tty', '--secret=1'], keys: [{ after: 'SAIP_R2_BUCKET', text: 'hunter2\r' }] },
  { id: 'INK-once', args: ['--probe=1', '--engine=once'], keys: [{ after: 'SAIP_R2_BUCKET', text: 'ink\r' }] },
  { id: 'INK-wizard', args: ['--probe=3', '--engine=wizard'], keys: [{ after: 'SAIP_R2_BUCKET', text: 'one\r' }, { after: 'SAIP_R2_ENDPOINT', text: 'two\r' }] },
]

for (const c of cases) {
  const e = await runProbe(c, env)
  console.log(`\n### ${c.id} code=${e.result.code} signal=${e.result.signal} hung=${e.result.hung} clean=${e.result.clean}`)
  console.log('    rows:', JSON.stringify(e.screenRows, null, 0))
  console.log('    raw-lines:', JSON.stringify(e.result.raw.split('\n').map((l) => l.replace(/\r/g, '').trimEnd()).filter(Boolean).slice(0, 10)))
  if (e.unparsed.length) console.log('    UNPARSED:', JSON.stringify(e.unparsed.slice(0, 6)))
}
