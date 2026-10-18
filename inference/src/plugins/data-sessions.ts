/**
 * data-sessions — Data API session-history ingestion. Stores uploaded agent
 * conversations under sessions/<id>/ (conversation.jsonl + manifest) so the
 * training gateway can read them for corrective SFT / KTO. Distinct from the
 * session-collector, which records inference-gateway-generated chats.
 */

import { Service } from 'cordis'
import { Hono } from 'hono'
import type { StorageProvider } from '../lib/backends.js'
import type { Message } from '../lib/config.js'

export interface DataSessionsConfig { storage: StorageProvider }
interface SessionEntry { id: string; caller: string; adapter_id: string; started_at: string; message_count: number; artifact_count: number }

declare module 'cordis' {
  interface Context { dataSessions?: DataSessionsService }
}

export class DataSessionsService extends Service {
  static readonly provide = 'dataSessions'
  readonly app = new Hono()
  private counter = 0

  constructor(ctx: any, private cfg: DataSessionsConfig) {
    super(ctx, 'dataSessions')
    this.app.post('/v1/data/sessions', (c) => this.create(c))
    this.app.get('/v1/data/sessions', (c) => this.list(c))
    this.app.get('/v1/data/sessions/:id', (c) => this.getOne(c))
  }

  private async readIndex(): Promise<{ sessions: Record<string, SessionEntry> }> {
    try { const raw = await this.cfg.storage.get('sessions/_index.json'); if (raw) return JSON.parse(raw) } catch {}
    return { sessions: {} }
  }
  private async writeIndex(idx: { sessions: Record<string, SessionEntry> }) { await this.cfg.storage.put('sessions/_index.json', JSON.stringify(idx, null, 2)) }

  private async create(c: any) {
    let body: any
    try { body = await c.req.json() } catch { return c.json({ error: { message: 'invalid JSON', code: 'invalid_request' } }, 400) }
    const { caller, adapter_id, messages } = body ?? {}
    if (!caller || !adapter_id || !Array.isArray(messages)) {
      return c.json({ error: { message: 'caller, adapter_id, messages required', code: 'invalid_request' } }, 400)
    }
    const id = `sess-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(++this.counter).padStart(3, '0')}`
    const entry: SessionEntry = { id, caller, adapter_id, started_at: new Date().toISOString(), message_count: messages.length, artifact_count: 0 }
    const conversation = (messages as Message[]).map((m) => JSON.stringify(m)).join('\n') + '\n'
    await this.cfg.storage.put(`sessions/${id}/conversation.jsonl`, conversation)
    await this.cfg.storage.put(`sessions/${id}/manifest.json`, JSON.stringify(entry, null, 2))
    const idx = await this.readIndex(); idx.sessions[id] = entry; await this.writeIndex(idx)
    this.ctx.emit('data/stored', { kind: 'session', id })
    return c.json(entry, 201)
  }

  private async list(c: any) {
    const limit = Number(c.req.query('limit') ?? 50), offset = Number(c.req.query('offset') ?? 0)
    const idx = await this.readIndex(); const entries = Object.values(idx.sessions)
    return c.json({ entries: entries.slice(offset, offset + limit), total: entries.length, limit, offset })
  }

  private async getOne(c: any) {
    const id = c.req.param('id'); const idx = await this.readIndex()
    if (!idx.sessions[id]) return c.json({ error: { message: 'not found', code: 'not_found' } }, 404)
    return c.json(idx.sessions[id])
  }
}
