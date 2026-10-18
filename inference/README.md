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
| `adapter-compiler` | Compile composite adapters (weighted merge of component deltas × gain) into single vLLM artifacts; recompile when a component promotes or the composition spec changes |
| `user-resolver` | Map caller identity → adapter group using file-based manifests |
| `session-collector` | Capture conversation histories, tool calls, artifacts for training |
| `data-api` | Hono HTTP server for Data API endpoints (`/v1/data/*`) — document upload, session history, feedback |
| `markdown-processor` | Process `.md`/`.mdx` files into structured text with heading hierarchy |
| `code-processor` | Process source code files into language-tagged code with metadata |
| `pdf-processor` | Process PDF documents via Marker OCR into extracted text with sections |
| `jsonl-processor` | Process JSONL datasets into validated record sequences |
| `api` | Hono HTTP server exposing OpenAI-compatible `/v1/chat/completions` |

Plugins communicate through Cordis events:

```
adapter/promoted    — new adapter available in R2
adapter/loaded      — adapter loaded into vLLM
session/complete    — conversation finished, ready for storage
user/resolved       — caller mapped to adapter group
document/uploaded   — new document received via Data API
document/processed  — document processor completed conversion
data/stored         — processed data written to R2
```

### Data Processing and R2 Storage

During awake mode, the inference gateway processes uploaded documents, session histories, and
feedback through its Data API (`/v1/data/*`). Document processor plugins (markdown, code, PDF/Marker
OCR, JSONL) run within the inference gateway because they may require model inference. All processed
data is written to R2 object storage, where the training gateway reads it as input for Axolotl
fine-tuning jobs. R2 serves as the handoff boundary between the two services.

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

### Adapter Compilation

Composite user adapters (`ΔW = gain × Σ(wᵢ·ΔWᵢ)`) must become a single file before vLLM can serve
them. The `adapter-compiler` plugin owns this in the inference gateway and splits responsibility
cleanly:

- **Planning (TypeScript, here):** resolve each component reference to a concrete version
  (honoring pins vs `@latest`), compute the weighted composition plan, detect staleness (a promoted
  component or edited spec invalidates the last compile), and emit a `CompositionRecord` capturing
  exactly which component versions + weights + gain produced the artifact. This logic is pure and
  unit-tested; it uses the shared `AdapterRegistryService`.
- **Execution (Python backend):** the actual tensor merge runs PEFT's `add_weighted_adapter` via a
  swappable backend invoked with the plan. The compiler treats it as an external step so the
  planning/resolution/provenance layer has no Python dependency and stays testable on its own.

A compiled composite is stored in R2 like any adapter version, tagged for its lineage, and served
by name — the same transparent resolution as leaf adapters. Composites are never trained directly;
training always targets their components (see [Adapter Definitions](https://adrianwebb.github.io/saip/reference/adapter-definitions/)).

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
