/**
 * data-feedback — Data API feedback/reward ingestion for weighted KTO. Validates
 * reward against the configured training.weighted_kto.reward_range, stores each
 * record under feedback/<id>.json, and maintains feedback/_index.json.
 */

import { Service } from 'cordis'
import { Hono } from 'hono'
import type { StorageProvider } from '../lib/backends.js'

export interface DataFeedbackConfig {
  storage: StorageProvider
  rewardRange?: [number, number]
}
interface FeedbackEntry { id: string; session_id: string; message_id?: string; reward: number; confidence?: number; dimensions?: Record<string, number>; feedback_text?: string; created_at: string }

declare module 'cordis' {
  interface Context { dataFeedback?: DataFeedbackService }
}

export class DataFeedbackService extends Service {
  static readonly provide = 'dataFeedback'
  readonly app = new Hono()
  private counter = 0

  constructor(ctx: any, private cfg: DataFeedbackConfig) {
    super(ctx, 'dataFeedback')
    this.app.post('/v1/data/feedback', (c) => this.create(c))
    this.app.get('/v1/data/feedback', (c) => this.list(c))
  }

  private async readIndex(): Promise<{ records: Record<string, FeedbackEntry> }> {
    try { const raw = await this.cfg.storage.get('feedback/_index.json'); if (raw) return JSON.parse(raw) } catch {}
    return { records: {} }
  }
  private async writeIndex(idx: { records: Record<string, FeedbackEntry> }) { await this.cfg.storage.put('feedback/_index.json', JSON.stringify(idx, null, 2)) }

  private async create(c: any) {
    let body: any
    try { body = await c.req.json() } catch { return c.json({ error: { message: 'invalid JSON', code: 'invalid_request' } }, 400) }
    const { session_id, message_id, reward, confidence, dimensions, feedback_text } = body ?? {}
    if (!session_id || typeof reward !== 'number') {
      return c.json({ error: { message: 'session_id and numeric reward required', code: 'invalid_request' } }, 400)
    }
    const [min, max] = this.cfg.rewardRange ?? [-3, 3]
    if (reward < min || reward > max) {
      return c.json({ error: { message: `reward must be within [${min}, ${max}]`, code: 'reward_out_of_range' } }, 422)
    }
    const id = `fb-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(++this.counter).padStart(3, '0')}`
    const entry: FeedbackEntry = { id, session_id, message_id, reward, confidence, dimensions, feedback_text, created_at: new Date().toISOString() }
    await this.cfg.storage.put(`feedback/${id}.json`, JSON.stringify(entry, null, 2))
    const idx = await this.readIndex(); idx.records[id] = entry; await this.writeIndex(idx)
    this.ctx.emit('data/stored', { kind: 'feedback', id })
    return c.json(entry, 201)
  }

  private async list(c: any) {
    const sessionId = c.req.query('session_id')
    const minR = c.req.query('min_reward'), maxR = c.req.query('max_reward')
    const limit = Number(c.req.query('limit') ?? 50), offset = Number(c.req.query('offset') ?? 0)
    const idx = await this.readIndex()
    let entries = Object.values(idx.records)
    if (sessionId) entries = entries.filter((e) => e.session_id === sessionId)
    if (minR != null) entries = entries.filter((e) => e.reward >= Number(minR))
    if (maxR != null) entries = entries.filter((e) => e.reward <= Number(maxR))
    return c.json({ entries: entries.slice(offset, offset + limit), total: entries.length, limit, offset })
  }
}
