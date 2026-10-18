/**
 * SAIP Training Gateway — Cordis application entry point
 *
 * Composes the training plugins: shared adapter registry service, learning API
 * (strategy registration + job linkage), Axolotl runner, and R2 sync as those
 * are implemented.
 */

import { Context } from 'cordis'
import { AdapterRegistryService } from '@saip/shared/services'
import { LearningApiService } from './plugins/learning-api.js'

export async function createApp() {
  const ctx = new Context()
  await ctx.plugin(AdapterRegistryService)
  await ctx.plugin(LearningApiService)
  // Remaining plugins (axolotlRunner, r2Sync) register here as they are implemented.
  return ctx
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void createApp().then(() => console.log('[saip-training] Gateway starting...'))
}
