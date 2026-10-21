import { render, Text } from 'ink'
import { FakeTTY, fakeStdout, textOf } from '../support/fake-tty.js'
import { askInkOnce } from './ink-engine.js'

const stdin = new FakeTTY()
const stdout = fakeStdout()

async function main(): Promise<void> {
  const p = askInkOnce('SAIP_R2_BUCKET: ', { stream: stdin as never, stdout: stdout as never, secret: false })
  await new Promise((r) => setTimeout(r, 60))
  stdin.feed('mybucket\r')
  const answer = await Promise.race([p, new Promise<string>((_, rej) => setTimeout(() => rej(new Error('TIMEOUT: engine never settled')), 3000))])
  console.log('ANSWER=' + JSON.stringify(answer))
  console.log('RAWMODE=' + JSON.stringify(stdin.rawModeLog))
  console.log('WRITES=' + JSON.stringify(textOf(stdout)))
  console.log('REF=' + stdin.refCount + ' UNREF=' + stdin.unrefCount)
  console.log('LISTENERS=' + stdin.listenerCount('readable'))
}

void main().then(() => process.exit(0)).catch((e) => { console.error('FAILED', e); process.exit(1) })
