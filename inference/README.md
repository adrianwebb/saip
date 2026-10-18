# SAIP Inference Gateway

The inference gateway serves OpenAI-compatible chat completions via vLLM with dynamic per-request
LoRA adapter selection. It is one of two core SAIP services (see [root README](../README.md)).

## Design

### Cordis Plugin Architecture

The inference gateway is a Cordis application composed of focused plugins:

| Plugin | Responsibility |
|--------|---------------|
| `vllm-manager` | Start/stop vLLM process, load/unload adapters, health checks |
| `adapter-registry` | Sync adapter index from R2, maintain local cache, resolve versions |
| `user-resolver` | Map caller identity → adapter group using file-based manifests |
| `session-collector` | Capture conversation histories, tool calls, artifacts for training |
| `api` | Hono HTTP server exposing OpenAI-compatible `/v1/chat/completions` |

Plugins communicate through Cordis events:

```
adapter/promoted    — new adapter available in R2
adapter/loaded      — adapter loaded into vLLM
session/complete    — conversation finished, ready for storage
user/resolved       — caller mapped to adapter group
```

### Request Flow

```
Client request (Authorization header)
    │
    ▼
Hono API middleware
    │ authenticate + extract caller identity
    ▼
User Resolver plugin
    │ caller → adapter group → specific adapter ID
    ▼
Adapter Registry plugin
    │ verify adapter exists, check local cache
    ▼
vLLM Manager plugin
    │ forward request with lora_adapter_name
    ▼
vLLM response
    │
    ├──► Client (streaming or complete)
    └──► Session Collector (background: store history)
```

### Adapter Selection

vLLM supports exactly one LoRA adapter per request. The inference gateway resolves which
adapter to use based on the caller's identity:

1. Extract caller identity from Authorization header or API key
2. Look up user manifest entry for that caller
3. Resolve the adapter alias (e.g., `general@latest`) to a concrete adapter version
4. Pass the adapter name to vLLM as `lora_adapter_name`

The caller never specifies an adapter directly. The gateway controls adapter assignment.

### SystemOne Endpoint

The same vLLM instance serves both standard inference and SystemOne decision modeling.
SystemOne requests use a separate API path but share the base model and adapter pool.
This allows decision models and inference to use identical learned weights.

### Docker Compose Services

```yaml
services:
  inference-api:        # Hono API server (Cordis app)
  vllm:                 # vLLM inference engine
  # Future: monitoring, session DB, etc.
```

## Configuration

Service-specific settings live under the `inference:` key in `saip.yaml`. See
[`saip.schema.yaml`](../saip.schema.yaml) for the full schema.

## Development

```bash
cd inference
pnpm install
pnpm dev          # Start development server
pnpm test         # Run tests
```
