# SAIP Training Gateway

The training gateway runs Axolotl fine-tuning jobs using processed data read from R2 object storage.
The inference gateway handles all data ingestion and document processing, writing results to R2.
The training gateway reads from R2 and dedicates its GPU entirely to training. It is one of two
core SAIP services (see [root README](../README.md)).

## Design

### Training Pipeline

The training gateway reads processed data from R2 (written by the inference gateway) and converts
it into strategy-specific Axolotl dataset formats using registered training strategy plugins.

```
R2 (processed data from inference gateway)
                ↓
Training Strategy Plugins
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

No vector databases, chunking, or embeddings are involved. Training strategy plugins transform
processed intermediate formats from R2 into their specific Axolotl dataset format. They do not
split or chunk data — they transform formats based on rules.

### Single API Surface: Learning API

| API | Path Prefix | Responsibility |
|-----|-------------|----------------|
| **Learning API** | `/v1/learning/*` | Training strategy registration, learning job management, feedback, optimization |

The training gateway exposes only the Learning API. All data ingestion (document upload, session
history, feedback submission) is handled by the inference gateway's Data API (`/v1/data/*`). The
two services communicate through R2: the inference gateway writes processed data, and the training
gateway reads it as input for training jobs. This separation ensures the training GPU is 100%
dedicated to Axolotl fine-tuning.

### Training Strategy Plugin Registry

The training gateway maintains a registry of training strategy plugins. Each strategy declares which
processed data formats it can consume from R2 and produces Axolotl datasets in its required format.

**Training Strategy Plugins** — each implements one learning method:

| Plugin | Consumes (from R2) | Produces |
|--------|---------------------|----------|
| `knowledge-embedding` | Processed documents | Completion-format text sequences |
| `corrective-sft` | Feedback-weighted messages | SFT dataset with per-turn weights |
| `weighted-kto` | Scalar reward records | KTO dataset with magnitude weights |
| *(extensible)* | *(declared types)* | *(strategy-specific Axolotl format)* |

These are **Cordis plugins that register themselves at startup**. A training strategy plugin
implements: "read processed data from R2 → produce Axolotl dataset." Adding a new training method
requires only one new plugin — zero changes to existing code. Document processing is handled
entirely by the inference gateway.

### Adapter Registry Linkage

Every leaf adapter in the `saip.yaml` registry declares its training linkage — `strategy` plus
`data_scopes` (see [Adapter Definitions](https://adrianwebb.github.io/saip/reference/adapter-definitions/)).
A learning job targeting an adapter inherits that linkage, so the path from user experience to
updated weights is explicit and auditable:

```
user → users[].adapters.training → adapter definition → training.strategy + data_scopes
         → matching strategy plugin → Axolotl dataset → trained adapter version → R2
```

Composite adapters are **not trainable** — they are compiled by the inference gateway from their
components' promoted versions. Training always targets leaves.

**Gateway plugins** orchestrate training:

| Plugin | Responsibility |
|--------|---------------|
| `training-strategy-registry` | Track registered strategies, load processed data from R2 for matching consumers |
| `learning-api` | Hono HTTP server for strategy listing and job management |
| `axolotl-runner` | Queue and execute Axolotl training jobs, manage GPU allocation |

Plugins communicate through Cordis events:

```
r2/data-updated         — new processed data available in R2 from inference gateway
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

All strategies consume processed data from R2 (written by the inference gateway) and produce QLoRA
adapters that are uploaded back to R2 for the inference gateway to serve.

### Background Processing

Training runs as a background process. The Learning API accepts job requests and manages the
training queue, while Axolotl executes asynchronously. The API remains responsive during
training. Training data is read from R2 — the training gateway never ingests data directly.

When operating in "sleep" mode on a single GPU, the inference gateway is stopped and the
training gateway has exclusive GPU access. On separate GPU nodes, both run simultaneously.
In either mode, processed data flows through R2 as the handoff boundary.

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
