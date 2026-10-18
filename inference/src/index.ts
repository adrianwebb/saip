/**
 * SAIP Inference Gateway — Cordis application entry point
 *
 * Loads plugins for vLLM management, adapter registry, user resolution,
 * session collection, and the Hono API server.
 */

import { Context } from 'cordis'

const ctx = new Context()

// TODO: Load configuration from saip.yaml
// TODO: Register plugins:
//   ctx.plugin(vllmManager, config)
//   ctx.plugin(adapterRegistry, config)
//   ctx.plugin(userResolver, config)
//   ctx.plugin(sessionCollector, config)
//   ctx.plugin(api, config)

console.log('[saip-inference] Gateway starting...')
console.log('[saip-inference] TODO: Implement plugin loading and vLLM integration')
