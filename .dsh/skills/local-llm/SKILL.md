---
name: local-llm
description: Local vLLM model server (Qwen3-4B-AWQ) with dual inference/systemone endpoints, Docker Compose stack management, and test runner operations for the dsh-chapters dev platform.
whenToUse: When working with the local LLM server, running or managing the Docker Compose stack (vllm, dsh-web, dsh-test), executing acceptance tests, configuring model endpoints, sending requests to the inference or decision models, or troubleshooting the containerized dev/test platform in dev/install/.
---

# Local LLM & Dev/Test Platform

The `dev/install/` directory is a self-contained development and test platform for
dsh-chapters: DSH Web UI, local vLLM model server, and CI test runner.

## Two Model Endpoints — When to Use Each

The vLLM service serves [Qwen/Qwen3-4B-AWQ](https://huggingface.co/Qwen/Qwen3-4B-AWQ)
under **two model names**. They share the same weights but serve different purposes.
Choosing the right one matters for correct system behavior.

### `qwen3-4b-instruct` — Inference Endpoint

**Use when**: generating text, answering questions, writing code, having conversations,
summarizing, translating, or any open-ended generation task.

This is the **default model** for DSH agent sessions. It handles all user-facing
interactions: chat completions, tool-call generation, plan drafting, chapter archiving
decisions that require reasoning over content.

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-4b-instruct",
    "messages": [
      {"role": "system", "content": "You are a helpful coding assistant."},
      {"role": "user", "content": "Explain how async/await works in JavaScript."}
    ],
    "max_tokens": 512,
    "temperature": 0.7
  }'
```

### `qwen3-4b-systemone` — Decision Endpoint

**Use when**: making binary/classification decisions, routing requests, evaluating
conditions, structured output (JSON), approval/rejection gates, or any task where the
output is a **discrete choice** rather than open-ended text.

This endpoint exists so the system can semantically separate "thinking" from "deciding."
Use it for: should-we-compact checks, plan approval classification, enrichment priority
scoring, transport failure triage, rule-match verdicts, or any yes/no/route-X-to-Y logic.

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-4b-systemone",
    "messages": [
      {"role": "system", "content": "You are a decision engine. Respond ONLY with valid JSON: {\"decision\": \"approve|reject\", \"confidence\": 0.0-1.0, \"reason\": \"brief explanation\"}"},
      {"role": "user", "content": "A session has used 85% of its context window. The current turn contains an active plan review. Should we trigger compaction now?"}
    ],
    "max_tokens": 128,
    "temperature": 0.1
  }'
```

### Key Differences in Usage

| Aspect | `qwen3-4b-instruct` | `qwen3-4b-systemone` |
|--------|---------------------|----------------------|
| **Output type** | Open-ended text, code, conversation | Structured decisions, classifications |
| **Temperature** | 0.7 (creative) | 0.1 (deterministic) |
| **Max tokens** | 512–15000 (generous) | 64–256 (tight) |
| **System prompt** | Conversational assistant | Decision schema + output format |
| **DSH role** | Agent sessions, tool calls, plans | Compaction gates, routing, triage |
| **When wrong** | Wastes tokens on verbose answers | Refuses creative tasks, too rigid |

### Why Two Names for One Model?

Semantic routing. The harness and plugins can route requests by **intent** rather than
by model capability. This makes the architecture explicit: a future upgrade can swap
the systemone endpoint to a specialized classifier without touching inference config.
Today they share weights; tomorrow they might not. Code that uses the right name today
is forward-compatible.

## Connecting to the Server

**Base URL**: `http://localhost:8080/v1` (from host) or `http://vllm:8080/v1` (inside containers)

**Authentication**: None required. Set `LOCAL_API_KEY=sk-local` if your client requires a key header.

**Verify it's running**:
```bash
curl http://localhost:8080/v1/models
# Returns: {"data":[{"id":"qwen3-4b-instruct",...},{"id":"qwen3-4b-systemone",...}]}

curl http://localhost:8080/health
# Returns: 200 OK when ready
```

**OpenAI-compatible**: The server implements the full OpenAI Chat Completions API.
Any client that speaks OpenAI format works — just point `base_url` at port 8080.

## Docker Compose Stack

Three services, started with `docker compose up -d` from `dev/install/`:

| Service | Port | Purpose |
|---------|------|---------|
| `vllm` | 8080 | Qwen3-4B-AWQ model server (inference + systemone) |
| `dsh-web` | 3080 | DSH Web UI with all plugins, pre-configured for vllm |
| `dsh-test` | *(none)* | Node.js 22 + Playwright + Chromium test runner |

Model weights are cached in the `dsh-vllm-cache` Docker volume — downloads once, boots
instantly after that. No `.env` file needed; Compose reads variables from your shell.

### Common Commands

```bash
# Start everything (export vars in shell first, no .env needed)
cd dev/install && docker compose up -d

# Run tests
docker compose run --rm dsh-test npm run test:e2e:replay
docker compose run --rm dsh-test npm run test:unit
docker compose run --rm dsh-test npm run coverage:ci

# Interactive test shell
docker compose exec dsh-test bash

# Stop / cleanup
docker compose down              # stop services, keep volumes
docker compose down -v           # also delete volumes (loses model cache)

# Native install (no Docker)
./dev/install/install.sh && dsh web
```

## Environment Variables

All variables are read from the **parent shell**. No `.env` file required. See
`.env.example` for the complete list with defaults. Key ones:

| Variable | Default | Description |
|----------|---------|-------------|
| `VLLM_MODEL_ID` | `Qwen/Qwen3-4B-AWQ` | HuggingFace model to serve |
| `VLLM_SERVED_NAMES` | `qwen3-4b-instruct,qwen3-4b-systemone` | Model aliases |
| `VLLM_MAX_MODEL_LEN` | `32768` | Context window size |
| `VLLM_GPU_MEM` | `0.90` | GPU memory utilization |
| `LLM_MODEL` | `qwen3-4b-instruct` | Default model for DSH sessions |
| `SYSTEMONE_MODEL` | `qwen3-4b-systemone` | Decision model name |

## Troubleshooting

- **vllm exits with `invalid human_readable_int_or_auto value: '${MAX_MODEL_LEN}'`** — the image
  predates the shell-form CMD fix (#19): exec-form `CMD ["...", "${VAR}", ...]` passes literal
  `${VAR}` strings to vLLM because Docker does not interpolate inside JSON arrays. Rebuild with
  `docker compose build --no-cache vllm`, then `docker compose up -d`. A stale `dsh-vllm` container
  is reused by `up`; remove it with `docker rm -f dsh-vllm` if compose keeps the old one.
- **`dependency vllm failed to start`** for `dsh-web`/`dsh-test` — always a symptom of the above or
  a failed healthcheck; fix vllm first, the dependents follow once healthy.

## Requirements

- **Containerized**: Docker ≥ 24, Compose v2, NVIDIA GPU ≥ 4 GB VRAM, nvidia-container-toolkit
- **Native**: Node.js ≥ 22, npm ≥ 10, Git, local model server at `localhost:8080`

## Files Reference

| File | Purpose |
|------|---------|
| `compose.yml` | Orchestration: vllm + dsh-web + dsh-test |
| `vllm.Dockerfile` | vLLM image with pre-downloaded model |
| `Dockerfile` | DSH Web UI image |
| `test.Dockerfile` | Test runner (Node 22 + Playwright + Chromium) |
| `docker-entrypoint.sh` | Generates settings, starts `dsh web` |
| `install.sh` / `uninstall.sh` | Native install/remove scripts |
| `.env.example` | Variable reference (not required at runtime) |
| `profile-cordis.patch.yml` | Full Cordis config mirror |
