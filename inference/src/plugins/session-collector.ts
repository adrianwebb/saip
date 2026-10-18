/**
 * session-collector — persists conversation history to storage on chat/request
 * events so the training gateway can later read sessions as corrective-SFT /
 * KTO input. Emits session/complete once a session record is written.
 */

import { Service } from 'cordis'
import type { Message } from '../lib/config.js'
import type { StorageProvider } from '../lib/backends.js'

interface ChatRequestEvent {
  caller: string | null
  adapter: string
  messages: Message[]
}

declare module 'cordis' {
  interface Events {
    'chat/request'(payload: ChatRequestEvent): void
    'session/complete'(payload: { sessionId: string; caller: string | null; adapterId: string }): void
  }
  interface Context {
    sessionCollector?: SessionCollectorService
  }
}

export interface SessionCollectorConfig {
  storage: StorageProvider
}

let counter = 0

export class SessionCollectorService extends Service {
  static readonly provide = 'sessionCollector'
  private pending: Promise<void>[] = []

  constructor(ctx: any, config: SessionCollectorConfig) {
    super(ctx, 'sessionCollector')
    const { storage } = config

    this.ctx.on('chat/request', (evt) => {
      const sessionId = `sess_${Date.now()}_${++counter}`
      const now = new Date().toISOString()
      const conversation = evt.messages.map((m) => JSON.stringify(m)).join('\n') + '\n'
      const manifest = {
        id: sessionId,
        caller: evt.caller ?? 'anonymous',
        adapter_id: evt.adapter,
        started_at: now,
        message_count: evt.messages.length,
        artifact_count: 0,
      }
      // Track the write so callers/tests can await completion via flush().
      const task = (async () => {
        await storage.put(`sessions/${sessionId}/conversation.jsonl`, conversation)
        await storage.put(`sessions/${sessionId}/manifest.json`, JSON.stringify(manifest))
        this.ctx.emit('session/complete', { sessionId, caller: evt.caller, adapterId: evt.adapter })
      })()
      this.pending.push(task)
      task.catch((e) => this.ctx.logger?.error?.(e))
    })
  }

  /** Await all in-flight session writes (used by tests and graceful shutdown). */
  async flush(): Promise<void> {
    await Promise.all(this.pending)
    this.pending = []
  }
}
