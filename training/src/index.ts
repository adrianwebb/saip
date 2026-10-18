/**
 * SAIP Training Gateway — Cordis application entry point
 *
 * Loads plugins for Axolotl runner, knowledge store, feedback store,
 * dataset builder, and the Hono API server.
 */

import { Context } from 'cordis'

const ctx = new Context()

// TODO: Load configuration from saip.yaml
// TODO: Register plugins:
//   ctx.plugin(axolotlRunner, config)
//   ctx.plugin(knowledgeStore, config)
//   ctx.plugin(feedbackStore, config)
//   ctx.plugin(datasetBuilder, config)
//   ctx.plugin(api, config)

console.log('[saip-training] Gateway starting...')
console.log('[saip-training] TODO: Implement plugin loading and Axolotl integration')
