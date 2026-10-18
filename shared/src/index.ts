/**
 * SAIP Shared Package — public API surface
 */

export * from './types.js'
export * from './adapter-registry.js'
// Services require a Cordis runtime; import from '@saip/shared/services'.
export { AdapterRegistryService, ADAPTER_REGISTRY_SERVICE } from './services.js'
