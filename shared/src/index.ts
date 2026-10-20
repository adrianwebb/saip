/**
 * SAIP Shared Package — public API surface
 */

export * from './types.js'
export * from './adapter-registry.js'
export * from './config-source.js'
export * from './secret-catalog.js'
export * from './secret-access.js'
export * from './hosting.js'
export * from './secrets-store.js'
export * from './profiles.js'
export * from './auth.js'
export * from './monitoring.js'
// Services require a Cordis runtime; import from '@saip/shared/services'.
export {
  AdapterRegistryService, ADAPTER_REGISTRY_SERVICE,
  SecretsService, SECRETS_SERVICE,
  HostRegistryService, HOST_REGISTRY_SERVICE,
  ProfileService, PROFILE_SERVICE,
} from './services.js'
