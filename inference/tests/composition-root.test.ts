/**
 * Composition-root acceptance tier (#76).
 *
 * Every other HttpVllmBackend test constructs the class by hand. Those tests would all have
 * passed — and did pass — while `createApp()` had no working way to build it, because the
 * default construction path (`backendFromEnv()`, driven by `SAIP_VLLM_BASE_URL`) had no test
 * at all. This file tests the wiring, not the parts: nothing is injected, and the collaborator
 * under test is the one production would choose.
 *
 * A real in-process HTTP server stands in for vLLM rather than a mocked `fetch`, so the
 * assertion is "the assembled gateway made an HTTP request to the configured engine and
 * surfaced its reply", which is the promise made to users.
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/index.js'
import { MemoryStorage } from '../src/lib/backends.js'

const repoConfig = fileURLToPath(new URL('../../saip.yaml', import.meta.url))

// Dev-mode comes from a config copy, not from injecting an auth bypass: config is data the
// composition root legitimately reads, and bypassing it by injection would hide wiring bugs.
function devModeConfig(): string {
  const src = readText(repoConfig)
  const p = join(mkdtempSync(join(tmpdir(), 'saip-comp-')), 'saip.yaml')
  writeFileSync(p, src.replace('security:\n  dev_mode: false', 'security:\n  dev_mode: true'))
  return p
}
function readText(p: string): string { return readFileSync(p, 'utf8') }

let server: Server | undefined
let stubUrl = ''
const seen: Array<{ path: string; body: any; headers: Record<string, unknown> }> = []

function startStub(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        seen.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : undefined, headers: req.headers })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          id: 'chatcmpl-stub', object: 'chat.completion', created: 1700000000,
          model: req.url?.includes('completions') ? undefined : 'unknown',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hello from the engine' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
        }))
      })
    })
    server!.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`))
  })
}

beforeEach(async () => {
  seen.length = 0
  if (!stubUrl) stubUrl = await startStub()
})

afterAll(async () => { await new Promise<void>((r) => server?.close(() => r())) })

describe('createApp() composition root: env-selected engine backend', () => {
  it('reaches the engine named by SAIP_VLLM_BASE_URL with nothing injected', async () => {
    const saved = process.env.SAIP_VLLM_BASE_URL
    process.env.SAIP_VLLM_BASE_URL = stubUrl
    try {
      // Storage is passed only to seed the adapter index BEFORE boot, because the index is read
      // at construction. It is the same MemoryStorage the app would have built itself, so the
      // seam actually under test here — the engine backend, deliberately NOT injected — stays
      // production-wired. That distinction is the whole point of this file.
      const storage = new MemoryStorage()
      await storage.put('adapters/_index.json', JSON.stringify({ aliases: { 'general@latest': 'general@42' } }))
      const ctx = (await createApp({ configPath: devModeConfig(), storage })) as any

      const res = await ctx.apiChat.app.request('/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'general', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.choices[0].message.content).toBe('hello from the engine')
      // The composition root resolved an HTTP backend from the environment and used it.
      expect(seen).toHaveLength(1)
      expect(seen[0].path).toBe('/v1/chat/completions')
      // Adapters are addressed by name through `model`, per the documented design, and the id
      // is the canonical zero-padded form from the adapter convention.
      expect(seen[0].body.model).toBe('general@000042')
    } finally {
      if (saved === undefined) delete process.env.SAIP_VLLM_BASE_URL
      else process.env.SAIP_VLLM_BASE_URL = saved
    }
  })

  it('answers 503, not a silent hang, when no engine is configured', async () => {
    const saved = process.env.SAIP_VLLM_BASE_URL
    delete process.env.SAIP_VLLM_BASE_URL
    try {
      const ctx = (await createApp({ configPath: devModeConfig() })) as any
      const res = await ctx.apiChat.app.request('/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      })
      expect(res.status).toBe(503)
      expect((await res.json()).error.code).toBe('backend_unavailable')
    } finally {
      if (saved !== undefined) process.env.SAIP_VLLM_BASE_URL = saved
    }
  })

  it('surfaces an unreachable configured engine as 503 backend_unavailable', async () => {
    const saved = process.env.SAIP_VLLM_BASE_URL
    // Port 1 never accepts; must be a typed failure, not an unhandled rejection.
    process.env.SAIP_VLLM_BASE_URL = 'http://127.0.0.1:1/v1'
    try {
      const storage = new MemoryStorage()
      await storage.put('adapters/_index.json', JSON.stringify({ aliases: { 'general@latest': 'general@42' } }))
      const ctx = (await createApp({ configPath: devModeConfig(), storage })) as any
      const res = await ctx.apiChat.app.request('/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'general', messages: [{ role: 'user', content: 'hi' }], max_tokens: 4 }),
      })
      expect(res.status).toBe(503)
      expect((await res.json()).error.code).toBe('backend_unavailable')
    } finally {
      if (saved === undefined) delete process.env.SAIP_VLLM_BASE_URL
      else process.env.SAIP_VLLM_BASE_URL = saved
    }
  })
})

describe('secret resolution reaches the encrypted store (#93)', () => {
  const built = true

  it('reads a value from the store through the wired composition, with nothing injected', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const d = mkdtempSync(join(tmpdir(), 'saip-wire-'))
    const path = join(d, 'secrets.enc.json')
    const pass = 'composition-root-passphrase'
    // Seed a real store using the production defaults (env passphrase, no injected provider).
    const { SecretStore, defaultKeySources } = await import('@saip/shared')
    const env = { SAIP_SECRETS_PASSPHRASE: pass, SAIP_SECRETS_FILE: path }
    const store = new SecretStore({ path, keySources: defaultKeySources(env, { storePath: path }) })
    await store.set('SAIP_R2_BUCKET', 'from-the-encrypted-store')

    const saved = { ...process.env }
    process.env.SAIP_SECRETS_FILE = path
    process.env.SAIP_SECRETS_PASSPHRASE = pass
    delete process.env.SAIP_R2_BUCKET
    try {
      const ctx = (await createApp({ configPath: devModeConfig() })) as any
      // The gateway's own secrets service — the wired default, not an injected provider.
      const value = await ctx.secrets.get('SAIP_R2_BUCKET')
      expect(value).toBe('from-the-encrypted-store')
    } finally {
      for (const k of ['SAIP_SECRETS_FILE', 'SAIP_SECRETS_PASSPHRASE']) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!
      }
    }
  })

  it('exposes the secret-access gateway as a Cordis service', async () => {
    const ctx = (await createApp({ configPath: devModeConfig() })) as any
    const gw = ctx.secretAccess
    expect(gw).toBeTruthy()
    expect(typeof gw.explain).toBe('function')
    expect(typeof gw.unlock).toBe('function')
  })
})
