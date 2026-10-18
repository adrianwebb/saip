# SAIP Shared Package

Shared **Cordis services** and types consumed by the inference gateway, training gateway, *and*
the CLI. One composition model across all four Node packages: everything is a plugin or an
injectable service.

## Modules

| Module | Purpose |
|--------|---------|
| `config-schema` | Zod/StandardSchema definitions for `saip.yaml` validation (includes the adapter registry) |
| `r2-client` | Cloudflare R2 operations as a Cordis service (upload, download, list, index) |
| `hf-client` | HuggingFace Hub model download and caching as a Cordis service |
| `adapter-manifest` | Read/write/search adapter manifests, `_index.json`, and alias resolution |
| `adapter-registry` | Load the `adapters:` registry; resolve leaf/composite definitions, validate scopes and cycles |
| `user-manifest` | User → adapter mapping from file-based manifests |
| `types` | Shared TypeScript contracts (`AdapterDefinition`, `CompositeSpec`, `TrainingLinkage`, manifests) |

## Architecture Role

`@saip/shared` provides stateless providers that the three applications inject via Cordis
dependency injection. Because every package resolves adapter aliases through the same service,
`saip status`, inference routing, and training sync can never disagree about what
`northstar-architect@latest` means — they consult one implementation.

```typescript
import { validateConfig } from '@saip/shared/config-schema'
import { R2Client } from '@saip/shared/r2-client'
import type { AdapterDefinition, AdapterManifest } from '@saip/shared/types'
```

## Development

```bash
cd shared
pnpm install
pnpm test         # Run tests
pnpm build        # Build for consumption by other packages
```

This package has no runtime dependencies on either service. All of `cli/`, `inference/`, and
`training/` depend on it via workspace references.
