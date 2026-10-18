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

### Cordis Plugin Architecture

| Plugin | Responsibility |
|--------|---------------|
| `document-type-router` | Identify document format and dispatch to appropriate processor |
| `document-processor` | Convert uploaded documents into intermediate format (pluggable per type) |
| `training-strategy-registry` | Manage registered training strategy providers |
| `data-api` | Hono HTTP server for document upload, processing, and feedback endpoints |
| `learning-api` | Hono HTTP server for training strategy registration and job management |
| `axolotl-runner` | Queue and execute Axolotl training jobs, manage GPU allocation |

Training strategies are **Cordis plugins that register themselves as providers**. Each strategy
plugin declares which intermediate formats it can consume and produces the corresponding Axolotl
dataset format. New strategies can be added without modifying core SAIP code.

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
