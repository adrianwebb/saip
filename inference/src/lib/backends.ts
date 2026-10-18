/**
 * Injectable backend seams for the inference gateway.
 *
 * External systems (object storage, the vLLM engine) are reached only through
 * these interfaces so plugins never import a concrete client. In-memory / fake
 * implementations make every endpoint deterministically testable without a GPU
 * or network; the real R2 client and HTTP vLLM adapter drop in unchanged.
 */

import type { Message } from './config.js'

export interface StorageProvider {
  put(key: string, body: string | Uint8Array): Promise<void>
  get(key: string): Promise<string | undefined>
  /** Keys under `prefix`, lexicographically sorted. */
  list(prefix: string): Promise<string[]>
  /** true if a key existed and was removed. */
  delete(key: string): Promise<boolean>
}

/** Default MVP storage: process-lifetime Map. Swap for R2-backed impl later. */
export class MemoryStorage implements StorageProvider {
  private readonly map = new Map<string, string>()

  async put(key: string, body: string | Uint8Array): Promise<void> {
    this.map.set(key, typeof body === 'string' ? body : Buffer.from(body).toString('utf8'))
  }
  async get(key: string): Promise<string | undefined> {
    return this.map.get(key)
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort()
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key)
  }
}

// ─── vLLM backend seam ────────────────────────────────────────

export interface VllmChatRequest {
  model: string
  messages: Message[]
  temperature?: number
  max_tokens?: number
  top_p?: number
  stop?: string | string[]
}

export interface VllmChatResponse {
  id: string
  created: number
  model: string
  choices: Array<{ index: number; message: Message; finish_reason: string }>
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export interface VllmBackend {
  chat(req: VllmChatRequest): Promise<VllmChatResponse>
  /** Optional streaming; each yielded string is one SSE `data:` payload. */
  stream?(req: VllmChatRequest): AsyncIterable<string>
}
