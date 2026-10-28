/**
 * Provenance labels must be checked, not guessed (#157).
 *
 * `config init` asks which of shell / `.env` / store holds a value and says so. `config get` and
 * `config list` did not ask: they looked at `process.env` and called whatever they found
 * "from shell environment — shadows the store value". For a value that arrived from the project's
 * `.env` — which is where the wizard itself puts interpolated configuration — that label sends the user
 * to their shell profile to edit a file, and it is exactly how #148's implicit autoload looked like shell
 * state for a whole release.
 *
 * Same repo, same fact, two answers: the wizard checked, get/list guessed confidently. #93's
 * declared-vs-inferred distinction with the roles reversed.
 *
 * Every case here injects its environment and its `.env` path, because this machine's shell exports
 * `SAIP_R2_BUCKET` — the same trap that produced #138's fragile suite and a false #110 row 5.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runConfig } from '../src/commands/config.js'
import { SecretStore, MemoryKeySource } from '@saip/shared'

const KEY = Buffer.alloc(32, 11)

function workspace(envFile: Record<string, string> = {}): { dir: string; envPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'saip-157-'))
  const envPath = join(dir, '.env')
  writeFileSync(envPath, Object.entries(envFile).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
  return { dir, envPath }
}

/** Run one `config` subcommand with everything injected; returns the rendered text. */
async function config(
  positional: string[],
  opts: { envPath: string; dir: string; shell?: Record<string, string>; storeNames?: Record<string, string> },
): Promise<string> {
  const store = new SecretStore({ path: join(opts.dir, 'secrets.enc.json'), keySources: [new MemoryKeySource('passphrase', KEY)] })
  for (const [k, v] of Object.entries(opts.storeNames ?? {})) await store.set(k, v)

  const out: string[] = []
  const cell = (b: any): string => `${b.kind ?? 'block'} ${JSON.stringify(b.rows ?? b.items ?? b.text ?? b.spec ?? '')}`
  const ui = {
    structured: false,
    showLine: (t: string) => out.push(t),
    show: (b: any) => out.push(cell(b)),
    showAll: (bs: any[]) => { for (const b of bs) out.push(cell(b)) },
    card: (s: any) => JSON.stringify(s),
    render: (b: any) => cell(b),
    prompt: async () => '',
    useRenderer: () => {},
  }
  // Scrub the ambient SAIP_* set FIRST, then layer the case's own values on top. Doing it the other
  // order — which is what this line first did — deletes the shell values the case just injected and
  // reports "is not set" for a fixture that set them.
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('SAIP_')) delete env[k]
  Object.assign(env, opts.shell ?? {})
  env.SAIP_SECRETS_PASSPHRASE = 'injected-passphrase'
  const result = await runConfig(store, {}, positional, { ui: ui as any, env, envPath: opts.envPath })
  // runConfig RETURNS blocks; rendering is the caller's job (the plugin does `ui.showAll(result.blocks)`),
  // which is why the first draft of this helper collected an empty string and looked like a total failure.
  for (const b of result.blocks) out.push(cell(b))
  return out.join('\n')
}

describe('config get names the source it actually found (#157)', () => {
  it('a value present only in the .env file is labelled .env, and never as the shell', async () => {
    const w = workspace({ SAIP_R2_BUCKET: 'bucket-in-the-file' })
    const r = await config(['get', 'SAIP_R2_BUCKET'], { ...w, })
    expect(r).toContain('bucket-in-the-file')
    expect(r).toMatch(/\.env/)
    expect(r).not.toMatch(/shell environment/)
  })

  it('a value in the shell AND the file names the shell as the winner and the file as the other place', async () => {
    const w = workspace({ SAIP_R2_BUCKET: 'bucket-in-the-file' })
    const r = await config(['get', 'SAIP_R2_BUCKET'], { ...w, shell: { SAIP_R2_BUCKET: 'bucket-in-the-shell' } })
    expect(r).toContain('bucket-in-the-shell')
    expect(r).toMatch(/shell/)
    expect(r).toMatch(/\.env/)                       // the other place is named, not hidden
    expect(r).not.toContain('bucket-in-the-file')    // …but the shadowed value is not shown as if live
  })

  it('a value only in the store says store, and does not mention the shell', async () => {
    const w = workspace()
    const r = await config(['get', 'SAIP_R2_BUCKET'], { ...w, storeNames: { SAIP_R2_BUCKET: 'bucket-in-the-store' } })
    expect(r).toContain('bucket-in-the-store')
    expect(r).toMatch(/store/i)
    expect(r).not.toMatch(/shell environment/)
  })

  it('a credential sitting in .env is reported as a problem and stays masked', async () => {
    const w = workspace({ SAIP_R2_SECRET_ACCESS_KEY: 'sk-from-the-file' })
    const r = await config(['get', 'SAIP_R2_SECRET_ACCESS_KEY'], w)
    expect(r).toMatch(/WARNING/)
    expect(r).toMatch(/store/)                        // says where it belongs
    expect(r).not.toContain('sk-from-the-file')       // masked unless --reveal, whatever the source
  })

  it('an unset name still says so, inventing no source', async () => {
    const w = workspace()
    const r = await config(['get', 'SAIP_R2_BUCKET'], w)
    expect(r).toMatch(/is not set/)
    expect(r).not.toMatch(/\.env|shell environment|encrypted store/i)
  })
})

describe('config list annotates only what it checked (#157)', () => {
  it('keeps the shell-shadow label for a genuinely shadowed store name', async () => {
    const w = workspace()
    const r = await config(['list'], { ...w, shell: { SAIP_R2_BUCKET: 'shell-bucket' }, storeNames: { SAIP_R2_BUCKET: 'stored-bucket' } })
    expect(r).toMatch(/shadowed by shell/)
  })

  it('marks a store name that is ALSO set in the .env file', async () => {
    const w = workspace({ SAIP_R2_BUCKET: 'file-bucket' })
    const r = await config(['list'], { ...w, storeNames: { SAIP_R2_BUCKET: 'stored-bucket' } })
    expect(r).toMatch(/also set in \.env/)
  })

  it('says nothing about sources it did not find', async () => {
    const w = workspace()
    const r = await config(['list'], { ...w, storeNames: { SAIP_R2_BUCKET: 'stored-bucket' } })
    expect(r).toMatch(/SAIP_R2_BUCKET/)
    expect(r).not.toMatch(/shadowed|also set in/)
  })
})

/**
 * The same fact at the level a user runs it (#76's rule). The injected-`deps` cases above can pass while
 * the plugin wires something different — `get`/`list` used to read `envFilePath(process.env)` and the
 * wizard read an `envPath` handed in by the caller, which is exactly the kind of near-miss that only
 * shows up once the assembled program is asked.
 */
describe('assembled program: the label survives the real wiring (#157)', () => {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
  const distBin = join(repoRoot, 'cli/dist/bin.js')

  it('config get names .env for a value that lives only in SAIP_ENV_FILE', async () => {
    if (!existsSync(distBin)) throw new Error(`${distBin} missing — run pnpm -r build first`)
    const w = workspace({ SAIP_R2_BUCKET: 'bucket-only-in-the-file' })
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const k of Object.keys(env)) if (k.startsWith('SAIP_')) delete env[k]
    Object.assign(env, {
      SAIP_ENV_FILE: w.envPath,
      SAIP_CONFIG: join(w.dir, 'saip.yaml'),
      SAIP_HOSTS_FILE: join(w.dir, 'hosts.yaml'),
      SAIP_SECRETS_FILE: join(w.dir, 'secrets.enc.json'),
      SAIP_SECRETS_PASSPHRASE: 'injected-passphrase',
    })
    writeFileSync(join(w.dir, 'saip.yaml'), 'storage:\n  r2:\n    bucket: ${SAIP_R2_BUCKET}\n')
    writeFileSync(join(w.dir, 'hosts.yaml'), 'hosts: []\n')
    const r = spawnSync(process.execPath, [distBin, 'config', 'get', 'SAIP_R2_BUCKET'], { env, encoding: 'utf8', timeout: 30_000, cwd: w.dir })
    const out = `${r.stdout}${r.stderr}`
    expect(out).toContain('bucket-only-in-the-file')
    expect(out).toMatch(/\.env/)
    expect(out).not.toMatch(/shell environment/)
  })
})
