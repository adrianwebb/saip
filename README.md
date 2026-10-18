# SAIP — Simple AI Platform

A two-service continual-learning platform that trains QLoRA adapters from agent experience and
serves them via vLLM with per-request adapter selection. Designed to run on a single 7 GB VRAM
GPU (e.g., gaming laptop) or scale to remote GPU nodes.

## Architecture

SAIP consists of two interlocking services connected through a shared remote object store
(Cloudflare R2) and a shared YAML configuration file.

```
┌──────────────────────────────────────────────────────────────┐
│                      SAIP Platform                           │
│                                                               │
│   saip.yaml (shared config)        .env (secrets, gitignored) │
│          │                               │                    │
│     ┌────┴─────┐                   ┌────┴─────┐              │
│     ▼          ▼                   ▼          ▼               │
│ ┌──────────┐ ┌──────────┐   ┌──────────┐ ┌──────────┐       │
│ │Inference │ │ Training │   │Inference │ │ Training │       │
│ │ Gateway  │ │ Gateway  │   │ Gateway  │ │ Gateway  │       │
│ │ (Hono)   │ │ (Hono)   │   │ (Hono)   │ │ (Hono)   │       │
│ └────┬─────┘ └────┬─────┘   └────┬─────┘ └────┬─────┘       │
│      │            │              │             │              │
│      ▼            ▼              ▼             ▼              │
│    vLLM        Axolotl         vLLM         Axolotl          │
│  + adapters    + QLoRA       + adapters     + QLoRA          │
│      │            │              │             │              │
│      └─────┬──────┘              └──────┬──────┘              │
│            │                            │                     │
│            ▼                            ▼                     │
│      Cloudflare R2 ◄──────────► Cloudflare R2                 │
│      (adapters + knowledge + sessions + feedback)             │
│                                                               │
│   HuggingFace Hub ◄── base model weights                      │
│   GitHub ◄── project config (saip.yaml)                       │
│   Hyperstack ◄── remote GPU compute (optional)                │
└──────────────────────────────────────────────────────────────┘
```

### Inference Gateway

Serves OpenAI-compatible chat completions via vLLM with dynamic per-request LoRA adapter
selection. A Hono API layer manages:

- **vLLM lifecycle** — start/stop the inference server, load/unload adapters
- **Adapter registry** — sync adapter index from R2, resolve user → adapter mapping
- **Session collection** — capture conversation histories for training feedback
- **SystemOne endpoint** — decision modeling on the same vLLM instance as inference
- **User resolution** — map caller identity to adapter group via file-based manifests

### Training Gateway

Runs Axolotl fine-tuning jobs in the background using three training methods:

- **Knowledge embedding** — continued pretraining on submitted documents, code, datasets
- **Corrective SFT** — supervised fine-tuning with per-turn feedback weighting
- **Weighted KTO** — preference learning with scalar reward magnitudes (-3 to +3)

A Hono API layer manages:

- **Knowledge submission** — accept and store documents in R2
- **Feedback submission** — accept evaluator feedback linked to sessions
- **Dataset construction** — transform experiences into Axolotl training formats
- **Training orchestration** — queue and run Axolotl jobs, promote resulting adapters

### Shared Infrastructure

- **Cloudflare R2** — adapters, knowledge, sessions, feedback (S3-compatible)
- **HuggingFace Hub** — base model weights
- **GitHub** — project configuration (`saip.yaml`)
- **Hyperstack** — optional remote GPU nodes for training or inference

Both services share a single `saip.yaml` configuration file and can run on the same machine
or on separate GPU nodes connected through R2.

## Monorepo Structure

```
saip/
├── saip.yaml              # Shared platform configuration
├── saip.schema.yaml       # JSON Schema for config validation
├── .env.example           # Secret variable template
├── cli/                   # saip CLI tool (awake/sleep/down/status)
├── inference/             # Inference Gateway (vLLM + Hono + Cordis)
├── training/              # Training Gateway (Axolotl + Hono + Cordis)
├── shared/                # Shared code (config, R2 client, types)
└── examples/cordis/       # Cordis framework reference
```

Each subproject has its own `package.json`, `tsconfig.json`, `CHANGELOG.md`, and `README.md`.

## Technology Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Plugin framework | [Cordis](https://github.com/cordiverse/cordis) v4 | Service composition, plugin lifecycle, events |
| Inference engine | [vLLM](https://github.com/vllm-project/vllm) | Multi-LoRA serving, AWQ quantization |
| Training framework | [Axolotl](https://github.com/axolotl-ai-cloud/axolotl) | QLoRA, SFT, KTO, continued pretraining |
| API framework | [Hono](https://hono.dev/) | Lightweight OpenAI-compatible HTTP API |
| Base model | Qwen3.5-4B (AWQ) | 7 GB VRAM target |
| Object storage | Cloudflare R2 | Adapters, knowledge, sessions |
| Containerization | Docker Compose v2 | Local and remote deployment |
| Language | TypeScript (Node.js ≥ 22) | All service and CLI code |

## Getting Started

### Prerequisites

- Node.js ≥ 22
- Docker and Docker Compose v2
- NVIDIA GPU with ≥ 7 GB VRAM (for local operation)
- Cloudflare R2 bucket
- HuggingFace account with access to Qwen3.5-4B

### Quick Start

```bash
# 1. Clone and install
git clone https://github.com/adrianwebb/saip.git
cd saip
pnpm install

# 2. Configure secrets
cp .env.example .env
# Edit .env with your R2 credentials, HF token, etc.

# 3. Review/edit configuration
cat saip.yaml

# 4. Start in inference mode
saip awake

# 5. Check status
saip status

# 6. Switch to training mode
saip sleep

# 7. Shut down
saip down
```

### Modes

SAIP operates in two mutually exclusive modes on a single GPU:

- **Awake** — inference gateway running, training gateway stopped. The system serves
  requests and collects session histories.
- **Asleep** — training gateway running, inference gateway stopped. The system processes
  accumulated experience into new adapters.

On separate GPU nodes, both services can run simultaneously.

## Configuration

All platform configuration lives in `saip.yaml` (committed). Secrets live in `.env`
(never committed). See [`saip.schema.yaml`](saip.schema.yaml) for the full schema and
[`inference/README.md`](inference/README.md) and [`training/README.md`](training/README.md)
for service-specific details.

## Remote Storage Layout

The Cloudflare R2 bucket follows this structure:

```
r2://<bucket>/
├── adapters/
│   ├── <adapter-id>/
│   │   ├── adapter_config.json
│   │   ├── adapter_model.safetensors
│   │   └── manifest.json          # version, parent, metrics, timestamps
│   └── _index.json                # Global adapter registry
├── knowledge/
│   ├── <knowledge-id>/
│   │   ├── content.*              # Raw documents, code, datasets
│   │   └── manifest.json          # source, license, hash, timestamps
│   └── _index.json                # Global knowledge registry
├── sessions/
│   ├── <session-id>/
│   │   ├── conversation.jsonl
│   │   ├── artifacts/
│   │   └── manifest.json
│   └── _index.json                # Global session registry
└── feedback/
    ├── <feedback-id>.json
    └── _index.json
```

## License

Apache 2.0 — see [LICENSE](LICENSE).
