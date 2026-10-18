# SAIP Training Gateway

The training gateway runs Axolotl fine-tuning jobs using experience collected by the inference
gateway and knowledge/feedback submitted through its API. It is one of two core SAIP services
(see [root README](../README.md)).

## Design

### Document Processing Pipeline

SAIP uses a document processing pipeline with pluggable training strategies. Documents are
uploaded via the Data API, routed by type, processed into an intermediate format, and then
converted into strategy-specific Axolotl dataset formats by registered training strategy plugins.

```
Document Upload → Document Type Router → Document Processor Plugin → Intermediate Format
                                                                        ↓
                                                        Training Strategy Plugins (providers)
                                                        ├── Knowledge Embedding (completion datasets)
                                                        ├── Corrective SFT (feedback-weighted messages)
                                                        ├── Weighted KTO (scalar reward records)
                                                        └── ...extensible
                                                                        ↓
                                                                 Axolotl Runner
                                                                        ↓
                                                                  QLoRA Adapter
                                                                        ↓
                                                         Upload to R2 + update index
```

No vector databases, chunking, or embeddings are involved. Document processors convert uploaded
documents into structured intermediate formats. Training strategy plugins then transform that
intermediate format into their specific Axolotl dataset format. Neither splits data — they
transform formats based on rules.

### Two API Surfaces

| API | Path Prefix | Responsibility |
|-----|-------------|----------------|
| **Data API** | `/v1/data/*` | Document upload, processing, storage, retrieval; feedback submission |
| **Learning API** | `/v1/learning/*` | Training strategy registration, learning job management, optimization |

The Data API handles all input data lifecycle. The Learning API manages which training strategies
are available and orchestrates training jobs. These two surfaces are intentionally separated: data
ingestion is decoupled from training execution.

### Two Plugin Registries

The training gateway maintains two independent plugin registries connected by an interface contract:

**Data Type Plugins** — each handles one document format:

| Plugin | Accepts | Produces |
|--------|---------|----------|
| `markdown-processor` | `.md`, `.mdx` files | Structured text with heading hierarchy |
| `code-processor` | Source code files | Language-tagged code with file structure metadata |
| `pdf-processor` | PDF documents | Extracted text with section boundaries |
| `jsonl-processor` | JSONL datasets | Validated record sequences |
| *(extensible)* | *(new formats)* | *(canonical intermediate format)* |

**Training Strategy Plugins** — each implements one learning method:

| Plugin | Consumes | Produces |
|--------|----------|----------|
| `knowledge-embedding` | Processed documents | Completion-format text sequences |
| `corrective-sft` | Feedback-weighted messages | SFT dataset with per-turn weights |
| `weighted-kto` | Scalar reward records | KTO dataset with magnitude weights |
| *(extensible)* | *(declared types)* | *(strategy-specific Axolotl format)* |

Both are **Cordis plugins that register themselves at startup**. A data type plugin implements
the interface: "accept raw document → return intermediate format." A training strategy plugin
implements: "accept intermediate format of declared types → produce Axolotl dataset." Neither
knows about the other's internals. Adding a new document type or a new training method requires
only one new plugin — zero changes to existing code.

**Gateway plugins** orchestrate the flow between the two registries:

| Plugin | Responsibility |
|--------|---------------|
| `document-type-router` | Inspect document format, dispatch to matching data type plugin |
| `training-strategy-registry` | Track registered strategies, route processed output to matching consumers |
| `data-api` | Hono HTTP server for document upload, processing, and feedback endpoints |
| `learning-api` | Hono HTTP server for strategy listing and job management |
| `axolotl-runner` | Queue and execute Axolotl training jobs, manage GPU allocation |

Plugins communicate through Cordis events:

```
document/uploaded       — new document received via Data API
document/processed      — document processor completed conversion
feedback/submitted      — new feedback record stored
learning/job-queued     — learning job added to queue
learning/job-started    — Axolotl job running
learning/job-complete   — adapter produced, ready for evaluation
adapter/promoted        — adapter passed evaluation, uploaded to R2
```

### Training Strategies

| Strategy | Input | What it teaches | Axolotl config |
|----------|-------|----------------|----------------|
| Knowledge embedding | Processed documents → completion datasets | Domain familiarity, world model | `type: completion`, continued pretraining |
| Corrective SFT | Feedback-weighted messages | How to correct mistakes, avoid repeating them | Custom SFT with feedback-weighted loss |
| Weighted KTO | Scalar reward records (-3 to +3) + confidence | Behavioral policy shaping | Custom KTO with magnitude weighting |

All strategies consume processed documents and/or feedback from the Data API and produce QLoRA
adapters that are uploaded back to R2 for the inference gateway to serve.

### Background Processing

Training runs as a background process. The Hono API accepts submissions and manages the
training queue, while Axolotl executes asynchronously. The API remains responsive during
training.

When operating in "sleep" mode on a single GPU, the inference gateway is stopped and the
training gateway has exclusive GPU access. On separate GPU nodes, both run simultaneously.

### Docker Compose Services

```yaml
services:
  training-api:         # Hono API server (Cordis app)
  axolotl-worker:       # Axolotl training process
  # Future: evaluation service, dataset preprocessing, etc.
```

## Configuration

Service-specific settings live under the `training:` key in `saip.yaml`. See
[`saip.schema.yaml`](../saip.schema.yaml) for the full schema.

## Development

```bash
cd training
pnpm install
pnpm dev          # Start development server
pnpm test         # Run tests
```
