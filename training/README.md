# SAIP Training Gateway

The training gateway runs Axolotl fine-tuning jobs using experience collected by the inference
gateway and knowledge/feedback submitted through its API. It is one of two core SAIP services
(see [root README](../README.md)).

## Design

### Three Training Methods

| Method | Input | What it teaches | Axolotl config |
|--------|-------|----------------|----------------|
| Knowledge embedding | Documents, code, datasets | Domain familiarity, world model | `type: completion`, continued pretraining |
| Corrective SFT | Session histories + per-turn feedback | How to correct mistakes, avoid repeating them | Custom SFT with feedback-weighted loss |
| Weighted KTO | Scalar rewards (-3 to +3) + confidence | Behavioral policy shaping | Custom KTO with magnitude weighting |

All three methods consume the same canonical experience records from R2 and produce QLoRA
adapters that are uploaded back to R2 for the inference gateway to serve.

### Cordis Plugin Architecture

| Plugin | Responsibility |
|--------|---------------|
| `axolotl-runner` | Queue and execute Axolotl training jobs, manage GPU allocation |
| `knowledge-store` | Accept knowledge submissions, store in R2, maintain index |
| `feedback-store` | Accept feedback linked to sessions, store in R2 |
| `dataset-builder` | Transform experiences into Axolotl-compatible training datasets |
| `api` | Hono HTTP server for knowledge/feedback/training management |

Plugins communicate through Cordis events:

```
knowledge/submitted     — new knowledge document stored
feedback/submitted      — new feedback record stored
training/queued         — training job added to queue
training/started        — Axolotl job running
training/complete       — adapter produced, ready for evaluation
adapter/promoted        — adapter passed evaluation, uploaded to R2
```

### Training Pipeline

```
Knowledge submissions ──────────┐
Session histories (from R2) ────┤
Feedback records ───────────────┤
                                ▼
                     Dataset Builder plugin
                                │
                    ┌───────────┼───────────┐
                    ▼           ▼           ▼
              Completion    SFT w/      KTO w/
              dataset      feedback     weights
                    │           │           │
                    └───────────┼───────────┘
                                ▼
                     Axolotl Runner plugin
                                │
                          QLoRA adapter
                                │
                                ▼
                     Upload to R2 + update index
                                │
                                ▼
                     Inference Gateway picks up
                     new adapter on next sync
```

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
