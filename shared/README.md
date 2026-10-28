# SAIP Shared Package

Shared **Cordis services** and types consumed by the inference gateway, training gateway, *and*
the CLI. One composition model across all four Node packages: everything is a plugin or an
injectable service.

## Modules

These are the subpath exports that **exist and are built**. The list is checked in CI by
`shared/tests/package-exports.test.ts` (#187), which asserts every specifier in `package.json`
resolves to a real file in `dist/` — five of the entries below used to be documented here with no
implementation behind any of them.

| Module | Purpose |
|--------|---------|
| `.` / `types` | Shared TypeScript contracts (`AdapterDefinition`, `CompositeSpec`, `TrainingLinkage`, manifests) |
| `config-source` | YAML loading with `${VAR}` interpolation, `.env` resolution, upward file discovery |
| `hosting` | `HostConfig`/`hosts.yaml` types, registry validation, `EnvSecrets`, deployment/auth seams |
| `secrets-store`* | Encrypted secret store: wraps, key sources (passphrase / keyring / `unattended`), atomic writes |
| `secret-catalog`* | Declared per-variable sensitivity and purpose — the source of "why is this asked for" |
| `secret-access`* | `SecretAccess` / `SecretAccessService`: the one gateway that unlocks, explains, reads, writes and audits |
| `adapter-registry` | Pure registry validation + resolution (`validateRegistry`, `parseRef`) — single source of truth for the rules |
| `profiles` | Hardware service profiles: tier validation, resolution against a probed GPU, `gpu_memory_utilization` derivation, vLLM arg rendering |
| `auth`, `monitoring` | Bearer/password auth seam, `MonitoringProvider` seam (noop default) |
| `services` | Cordis wrappers putting the above on `ctx`: `AdapterRegistryService`, `HostRegistryService`, `SecretsService`, `ProfileService`, `SecretAccessService` |

\* exported from the package root rather than as a subpath.

### Planned, not implemented

`config-schema`, `r2-client`, `hf-client`, `adapter-manifest` and `user-manifest` were all listed here as
if they shipped. None of them existed — no source file, no built output, and `@saip/shared/config-schema`
would have failed at import for anyone following this README. The Cloudflare R2 client is the substantive
one and is the remaining work of epic
[#63](https://github.com/adrianwebb/saip/issues/63) (A3); the rest are
[#187](https://github.com/adrianwebb/saip/issues/187)'s deleted specifiers, to be re-added in the change
that implements them.

## Architecture Role

`@saip/shared` provides stateless providers that the three applications inject via Cordis dependency
injection. What that guarantee actually covers today is the **adapter registry, the host registry, the
profiles resolver and the secret store/gateway**: because every package resolves through the same
service, `saip status`, inference routing and training sync cannot disagree about what
`northstar-architect@latest` means, which host is `default`, or which tier fits the card.

It does **not** yet extend to storage: there is no shared R2 client, so object-key layout is today a
convention documented in [the R2 bucket layout
reference](https://adrianwebb.github.io/saip/reference/r2-bucket-layout/) rather than one implementation
three applications consult (#63 A3/A3b).

```typescript
import type { AdapterDefinition, AdapterManifest } from '@saip/shared/types'
import { AdapterRegistryService, HostRegistryService, ProfileService } from '@saip/shared/services'
import { SecretAccessService } from '@saip/shared'
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
