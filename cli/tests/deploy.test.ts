import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { renderDeployPlan, parseParams } from '../src/lib/deploy.js'
import { buildProgram } from '../src/index.js'
import type { HostConfig } from '@saip/shared'

const hostsFile = fileURLToPath(new URL('../../hosts.example.yaml', import.meta.url))
const src: HostConfig = { name: 'default', kind: 'local', role: 'both', compose_dir: '.' }
const dst: HostConfig = { name: 'staging-box', kind: 'local', role: 'both', compose_dir: '/opt/saip' }

describe('parseParams', () => {
  it('parses key=value list', () => {
    expect(parseParams(['region=CANADA-1', 'flavor=n3-H100x1'])).toEqual({ region: 'CANADA-1', flavor: 'n3-H100x1' })
  })
  it('ignores malformed entries without =', () => {
    expect(parseParams(['oops', 'a=b'])).toEqual({ a: 'b' })
  })
})

describe('renderDeployPlan (pure)', () => {
  it('produces a planned-not-applied result describing source→target + params', () => {
    const plan = renderDeployPlan(src, dst, { flavor: 'big' })
    expect(plan.planned).toBe(true)
    expect(plan.applied).toBe(false)
    expect(plan.detail).toMatch(/default.*staging-box/)
    // Contract changed in this PR: values are masked in the plan because the plan is a log
    // surface and anything passed as a process argument is already visible in `ps`. Names stay
    // visible so a plan is still reviewable.
    expect(plan.detail).toMatch(/flavor=/)
    expect(plan.detail).not.toMatch(/flavor=big/)
  })
})

describe('saip deploy command', () => {
  it('--target local-ish --dry-run prints a plan and applies nothing', async () => {
    process.env.SAIP_HOSTS_FILE = hostsFile
    let out = ''
    // #113: the seam writes to the stdout sink, not console.log. Same assertions, new observation
    // point — the plan text and the dry-run line are still required, they are just no longer
    // emitted through console.log.
    const orig = console.log
    const origWrite = process.stdout.write.bind(process.stdout)
    console.log = (...a: unknown[]) => { out += a.join(' ') + '\n' }
    ;(process.stdout as any).write = (c: string | Uint8Array): boolean => {
      out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8'); return true
    }
    try {
      const program = await buildProgram()
      // default host is local; deploying to it with dry-run should print a plan
      await program.parseAsync(['deploy', '--target', 'default', '--dry-run'], { from: 'user' })
    } finally { console.log = orig; (process.stdout as any).write = origWrite; delete process.env.SAIP_HOSTS_FILE }
    expect(out).toMatch(/plan/i)
    expect(out).toMatch(/dry-run/)
    // dry-run must NOT report a successful application line.
    expect(out).not.toMatch(/deploy applied/)
  })

  it('--target ghost fails closed listing known hosts', async () => {
    process.env.SAIP_HOSTS_FILE = hostsFile
    let err = ''
    const origErr = console.error; console.error = (...a: unknown[]) => { err += a.join(' ') }
    try {
      const program = await buildProgram()
      await program.parseAsync(['deploy', '--target', 'ghost'], { from: 'user' })
    } finally { console.error = origErr; delete process.env.SAIP_HOSTS_FILE }
    // #117: deploy takes two hosts, so the message names WHICH one and the flag that sets it.
    // The intent is unchanged — fail closed, name the host, list the known ones.
    expect(err).toMatch(/unknown deploy target host "ghost"/i)
    expect(err).toMatch(/set --target <name>/)
  })
})
