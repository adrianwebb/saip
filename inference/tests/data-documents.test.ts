import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/index.js'
import { MemoryStorage } from '../src/lib/backends.js'

const repoConfig = fileURLToPath(new URL('../../saip.yaml', import.meta.url))

async function boot() {
  const storage = new MemoryStorage()
  const ctx = (await createApp({ configPath: repoConfig, storage })) as any
  return { app: ctx.dataDocuments.app, storage }
}

describe('Data API documents', () => {
  it('POST uploads, processes, stores manifest + content, returns 201', async () => {
    const { app, storage } = await boot()
    const res = await app.request('/v1/data/documents', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'wiki/arch.md', source_type: 'document', content: '# Arch\nbody', tags: ['arch'] }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.processed_by).toBe('markdown-processor')
    expect(body.id).toMatch(/^doc-/)
    // stored under knowledge/<id>/
    const keys = await storage.list(`knowledge/${body.id}/`)
    expect(keys.some((k) => k.endsWith('manifest.json'))).toBe(true)
    expect(keys.some((k) => k.endsWith('content.md'))).toBe(true)
  })

  it('dedups identical content by hash — flagged, no duplicate stored', async () => {
    const { app, storage } = await boot()
    const payload = { source: 'a.md', source_type: 'document', content: '# Same\ncontent' }
    const r1 = await (await app.request('/v1/data/documents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).json()
    const r2res = await app.request('/v1/data/documents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    const r2 = await r2res.json()
    expect(r2.duplicate).toBe(true)
    expect(r2.id).toBe(r1.id)
    // only one knowledge entry exists for that id
    const manifests = (await storage.list('knowledge/')).filter((k) => k.endsWith('manifest.json'))
    expect(manifests.length).toBe(1)
  })

  it('rejects unsupported type with 4xx and stores nothing', async () => {
    const { app, storage } = await boot()
    const res = await app.request('/v1/data/documents', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'x.zip', source_type: 'document', content: 'binary-ish' }),
    })
    expect(res.status).toBe(422)
    expect(await storage.list('knowledge/')).toHaveLength(0)
  })

  it('GET lists documents; DELETE removes content + index entry', async () => {
    const { app, storage } = await boot()
    const created = await (await app.request('/v1/data/documents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'd.md', source_type: 'document', content: '# D\ntext' }) })).json()
    const list = await (await app.request('/v1/data/documents')).json()
    expect(list.entries.map((e: any) => e.id)).toContain(created.id)
    const del = await app.request(`/v1/data/documents/${created.id}`, { method: 'DELETE' })
    expect(del.status).toBe(204)
    expect(await storage.get(`knowledge/${created.id}/manifest.json`)).toBeUndefined()
  })
})
