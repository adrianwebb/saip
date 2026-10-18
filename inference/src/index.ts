/**
 * SAIP Inference Gateway — Cordis application entry point
 *
 * Composes the inference plugins: adapter registry + compiler (from shared),
 * plus vLLM management, user resolution, session collection, data processing,
 * and the Hono API server as those are implemented.
 */

import { Context } from 'cordis'
import { AdapterRegistryService } from '@saip/shared/services'
import { AdapterCompilerService } from './plugins/adapter-compiler.js'

export async function createApp() {
  const ctx = new Context()
  // Shared services first so dependents can inject them via ctx.
  await ctx.plugin(AdapterRegistryService)
  await ctx.plugin(AdapterCompilerService)
  // Remaining plugins (vllmManager, userResolver, sessionCollector, dataApi, api)
  // register here as they are implemented.
  return ctx
}

// Only boot when run directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  void createApp().then(() => console.log('[saip-inference] Gateway starting...'))
}
