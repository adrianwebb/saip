import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PtyRun, isolatedEnv } from '../support/pty.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const distBin = join(here, '..', '..', 'dist', 'bin.js')
const node = process.execPath

const cases: Array<{ id: string; args: string[]; keys: Array<{ after?: string; text: string }> }> = [
  // The shipped tty engine, at the artifact level: does `config set` return? (#151 hang class)
  { id: 'ART-set-prompted', args: [distBin, 'config', 'set', 'SAIP_SPIKE_SECRET'], keys: [{ after: 'SAIP_SPIKE_SECRET', text: 'spike-value\r' }] },
  { id: 'ART-set-stdin', args: [distBin, 'config', 'set', 'SAIP_SPIKE_SECRET', '--stdin'], keys: [{ after: '', text: '' }] },
  { id: 'ART-list', args: [distBin, 'config', 'list'], keys: [] },
  { id: 'ART-status', args: [distBin, 'status'], keys: [] },
]

for (const c of cases) {
  const env = isolatedEnv({ SAIP_SECRETS_PASSPHRASE: 'spike-passphrase' })
  const run = new PtyRun({ cmd: node, args: c.args, env, cols: 200, rows: 40 })
  for (const k of c.keys) {
    if (k.after) await run.waitFor(k.after, 15_000)
    if (k.text) run.write(k.text)
  }
  await run.settle(400)
  const r = await run.finish(12_000)
  console.log(`\n### ${c.id} code=${r.code} signal=${r.signal} hung=${r.hung} clean=${r.clean} elapsed=${r.elapsedMs}`)
  const rows = r.raw.split('\n').map((l) => l.replace(/\r/g, '').trimEnd()).filter(Boolean)
  for (const line of rows.slice(0, 12)) console.log('   | ' + line.slice(0, 150))
}
