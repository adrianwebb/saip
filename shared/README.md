# SAIP Shared Package

Shared code used by both the inference and training gateways. This package provides common
types, configuration validation, remote storage clients, and manifest management.

## Modules

| Module | Purpose |
|--------|---------|
| `config-schema` | Zod/StandardSchema definitions for `saip.yaml` validation |
| `r2-client` | Cloudflare R2 operations (upload, download, list, index) |
| `hf-client` | HuggingFace Hub model download and caching |
| `adapter-manifest` | Read/write/search adapter manifests and the global `_index.json` |
| `user-manifest` | User → adapter group mapping from file-based manifests |
| `types` | Shared TypeScript type definitions |

## Usage

```typescript
import { validateConfig } from '@saip/shared/config-schema'
import { R2Client } from '@saip/shared/r2-client'
import type { AdapterManifest } from '@saip/shared/types'
```

## Development

```bash
cd shared
pnpm install
pnpm test         # Run tests
pnpm build        # Build for consumption by other packages
```

This package has no runtime dependencies on either service. Both `inference/` and `training/`
depend on it via workspace references.
