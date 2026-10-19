/**
 * data-documents — Data API document ingestion. Validates, dedups by sha256,
 * routes to the matching processor plugin, stores content + manifest under
 * knowledge/<id>/ in storage, and maintains knowledge/_index.json. Emits
 * document/uploaded, document/processed, data/stored for other plugins.
 */

import { Service } from 'cordis'
import { Hono } from 'hono'
import { createHash } from 'node:crypto'
import type { StorageProvider } from '../lib/backends.js'
import { processorFor, type ProcessMeta } from '../lib/doc-processors.js'

export interface DataDocumentsConfig {
  storage: StorageProvider
}

interface DocIndexEntry { id: string; source: string; source_type: string; hash: string; size_bytes: number; processed_by: string; tags?: string[]; created_at: string }

const MAX_BYTES = 10 * 1024 * 1024 // 10 MB text guard (MVP)

declare module 'cordis' {
  interface Context {
    dataDocuments?: DataDocumentsService
  }
  interface Events {
    'document/uploaded'(payload: { source: string; source_type: string }): void
    'document/processed'(payload: { source: string; processed_by: string }): void
    'data/stored'(payload: { kind: string; id: string }): void
  }
}

export class DataDocumentsService extends Service {
  static readonly provide = 'dataDocuments'
  readonly app = new Hono()
  private counter = 0

  constructor(ctx: any, private cfg: DataDocumentsConfig) {
    super(ctx, 'dataDocuments')
    this.app.post('/v1/data/documents', (c) => this.create(c))
    this.app.get('/v1/data/documents', (c) => this.list(c))
    this.app.delete('/v1/data/documents/:id', (c) => this.remove(c))
  }

  private extOf(source: string): string | undefined {
    const m = source.match(/(\.[A-Za-z0-9]+)$/)
    return m ? m[1].toLowerCase() : undefined
  }

  private async readIndex(): Promise<{ documents: Record<string, DocIndexEntry> }> {
    try {
      const raw = await this.cfg.storage.get('knowledge/_index.json')
      if (raw) return JSON.parse(raw)
    } catch { /* ignore */ }
    return { documents: {} }
  }
  private async writeIndex(idx: { documents: Record<string, DocIndexEntry> }) {
    await this.cfg.storage.put('knowledge/_index.json', JSON.stringify(idx, null, 2))
  }

  private async create(c: any) {
    let body: any
    try { body = await c.req.json() } catch { return c.json({ error: { message: 'invalid JSON', code: 'invalid_request' } }, 400) }
    const { source, source_type, content, license, tags } = body ?? {}
    if (!source || !source_type || typeof content !== 'string') {
      return c.json({ error: { message: 'source, source_type, content required', code: 'invalid_request' } }, 400)
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
      return c.json({ error: { message: 'document exceeds size limit', code: 'too_large' } }, 413)
    }
    if (!/^[\x09\x0A\x0D\x20-\x7E\x85\xA0-\uD7FF\uE000-\uFFFD]|[\s\S]/.test(content) && content.includes('\uFFFD')) {
      return c.json({ error: { message: 'content must be UTF-8 text', code: 'encoding' } }, 415)
    }

    const meta: ProcessMeta = { sourceType: source_type, ext: this.extOf(source) }
    const processor = processorFor(meta)
    if (!processor) return c.json({ error: { message: `unsupported document type: ${meta.ext ?? source_type}`, code: 'unsupported_type' } }, 422)

    const hash = 'sha256:' + createHash('sha256').update(content).digest('hex')
    const index = await this.readIndex()
    const existing = Object.values(index.documents).find((d) => d.hash === hash)
    if (existing) {
      return c.json({ ...existing, duplicate: true }, 200)
    }

    this.ctx.emit('document/uploaded', { source, source_type })
    let processed: { intermediate: string; processedBy: string }
    try { processed = processor.process(content, meta) } catch (e: any) {
      return c.json({ error: { message: e.message, code: 'processing_failed' } }, 422)
    }
    this.ctx.emit('document/processed', { source, processed_by: processed.processedBy })

    const id = `doc-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(++this.counter).padStart(3, '0')}`
    const contentExt = meta.ext ?? '.txt'
    const entry: DocIndexEntry = { id, source, source_type, hash, size_bytes: Buffer.byteLength(content, 'utf8'), processed_by: processed.processedBy, tags, created_at: new Date().toISOString() }

    await this.cfg.storage.put(`knowledge/${id}/content${contentExt}`, processed.intermediate)
    await this.cfg.storage.put(`knowledge/${id}/manifest.json`, JSON.stringify(entry, null, 2))
    index.documents[id] = entry
    await this.writeIndex(index)
    this.ctx.emit('data/stored', { kind: 'document', id })

    return c.json(entry, 201)
  }

  private async list(c: any) {
    const tag = c.req.query('tag')
    const limit = Number(c.req.query('limit') ?? 50)
    const offset = Number(c.req.query('offset') ?? 0)
    const index = await this.readIndex()
    let entries = Object.values(index.documents)
    if (tag) entries = entries.filter((e) => e.tags?.includes(tag))
    const total = entries.length
    return c.json({ entries: entries.slice(offset, offset + limit), total, limit, offset })
  }

  private async remove(c: any) {
    const id = c.req.param('id')
    const index = await this.readIndex()
    if (!index.documents[id]) return c.json({ error: { message: 'not found', code: 'not_found' } }, 404)
    const extKeys = await this.cfg.storage.list(`knowledge/${id}/`)
    for (const k of extKeys) await this.cfg.storage.delete(k)
    delete index.documents[id]
    await this.writeIndex(index)
    return c.body(null, 204)
  }
}
