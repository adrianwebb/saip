import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/index.js'
import type { MonitoringProvider } from '@saip/shared'
import type { VllmBackend, VllmChatRequest, VllmChatResponse } from '../src/lib/backends.js'

const repoConfig = fileURLToPath(new URL('../../saip.yaml', import.meta.url))

class Counter implements MonitoringProvider {
  counters: Record<string, number> = {}
  counter(name: string) { this.counters[name] = (this.counters[name] ?? 0) + 1 }
  gauge() {} histogram() {}
}
class Throwing implements MonitoringProvider {
  counter() { throw new Error('boom') } gauge() { throw new Error('boom') } histogram() { throw new Error('boom') }
}
const fakeVllm = (): VllmBackend => ({ async chat(req: VllmChatRequest): Promise<VllmChatResponse> { return { id: 'x', created: 1, model: req.model, choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } } })
const devCfg = async () => ({ ...(await import('../src/lib/config.js')).loadConfig(repoConfig), security: { dev_mode: true as const, api_tokens: [] } })

describe('inference metrics emission', () => {
  it('counts a chat request via the event bridge', async () => {
    const sink = new Counter()
    const ctx = (await createApp({ config: await devCfg(), vllm: fakeVllm(), monitoring: sink, latestVersion: () => 42 })) as any
    await ctx.server.app.request('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) })
    await ctx.sessionCollector.flush()
    expect(sink.counters['saip_chat_requests_total']).toBe(1)
    expect(sink.counters['saip_sessions_collected_total']).toBe(1)
  })

  it('Review-Focus #6: a throwing sink never breaks serving', async () => {
    const ctx = (await createApp({ config: await devCfg(), vllm: fakeVllm(), monitoring: new Throwing(), latestVersion: () => 42 })) as any
    const res = await ctx.server.app.request('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) })
    expect(res.status).toBe(200) // metrics failed silently; request still served
  })
})
