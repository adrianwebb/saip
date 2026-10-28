---
name: local-llm
description: SAIP's local model stack — the vLLM inference engine and gateway, the Axolotl training stack, the hardware service profiles that size them, and the `saip awake/sleep/down/status` verbs that drive both.
whenToUse: When starting, stopping, or troubleshooting the local inference or training stacks, choosing or resolving a service profile for this machine's GPU, pointing a client at the inference gateway, generating vLLM engine arguments, loading or swapping LoRA adapters, or diagnosing an engine OOM or failed health check.
---

# Local Model Stack (SAIP)

SAIP runs two Docker Compose stacks on the machine it is installed on — one serving, one
training. Which one is up is a mode, not a coincidence: `saip awake` brings the inference
stack up, `saip sleep`/`down` take it back, and the training stack is driven separately.

Both stacks live in this repository's own subprojects — there is no separate vendored platform
directory and no test-runner container here. Every path below exists in this checkout.

## What actually runs

| Service | Compose file | Host port (default) | Image |
|---|---|---|---|
| `inference-api` — the gateway | `inference/docker-compose.yml` | `${SAIP_INFERENCE_PORT:-8000}` → 8000 | built from `inference/Dockerfile` |
| `vllm` — the engine | `inference/docker-compose.yml` | `${SAIP_VLLM_PORT:-8081}` → 8000 inside | `saip-vllm:v0.31.0` (from `inference/vllm.Dockerfile`, base `vllm/vllm-openai:v0.31.0`) |
| `training-api` | `training/docker-compose.yml` | `${SAIP_TRAINING_PORT:-8001}` → 8001 | built from `training/Dockerfile` |
| `axolotl-worker` | `training/docker-compose.yml` | — | `winglian/axolotl:main-latest` |

The gateway reaches the engine by compose service name, not by a host port:
`SAIP_VLLM_BASE_URL: http://vllm:8000/v1`. The host mapping (`8081`) exists only so you can curl
the engine directly — 8080 is deliberately left free for machines where something else already
holds it.

Served checkpoint (from `saip.yaml`, `model:`):

```yaml
base: "QuantTrio/Qwen3.5-4B-AWQ"     # pinned by revision below
revision: "32c292e3a73afe1138518180b1b6d2868c980ee2"
quantization: "awq"
```

`base` must name a checkpoint **already quantized** in `quantization` — vLLM cannot AWQ-quantize a
BF16 repo at load time, and there is no official Qwen AWQ build of this model, which is why the
reference checkpoint is the community QuantTrio build, pinned.

## Start it (the CLI is the supported path)

```bash
cp .env.example .env      # R2 credentials, HF token, etc.
saip awake                # generates engine args for THIS GPU, then brings the stack up
saip status               # what is up, on which ports, which profile was resolved
saip sleep                # inference down
saip down                 # both stacks down
```

`saip awake` takes `--profile <name>` to hold a machine to a specific tier for one run; with no
flag the profile is auto-resolved against the probed GPU.

To drive Compose directly (debugging, or when the CLI is not built):

```bash
npx tsx inference/scripts/generate-engine-args.ts          # REQUIRED first step
docker compose -f inference/docker-compose.yml up -d
docker compose -f inference/docker-compose.yml logs -f vllm
```

## Why engine args are generated, never committed

`--gpu-memory-utilization` is a fraction of the card's **total** memory, and the engine aborts at
startup if **free** memory at launch falls below that product. A constant committed to the compose
file is wrong on every card except the one it was tuned for, and unusable on a shared desktop GPU.
`inference/scripts/generate-engine-args.ts` renders the active service profile into
`inference/.engine-args.env` (read by the `vllm` service via `env_file`), deriving
`gpu_memory_utilization` from the profile's `vram_ceiling_gib` over total memory and gating it on
measured free memory.

Resolution **fails closed**: exit 2 when no profile tier fits, rather than letting the engine OOM
later. So an absent `.engine-args.env`, or one older than the profile you just edited, is the first
thing to suspect when the container restarts without a readable error.

Hardware-dependent knobs (`max_model_len`, `kv_cache_dtype`, `enforce_eager`) belong to the active
**profile**, never to `model:`.

## Profiles are the hardware contract

`saip.yaml` declares tiers keyed by the GPU they were measured on. The shipped `inference-8gb`
tier is the shape to copy:

```yaml
profiles:
  inference-8gb:
    min_vram_gib: 8
    min_capability: 7.5
    vram_ceiling_gib: 7.0
    engine:
      max_model_len: 24576
      kv_cache_dtype: auto
      language_model_only: true
      enforce_eager: true     # CUDA graphs are unaffordable at this tier (~2.65 GiB)
```

`enforce_eager` is a memory decision, not a preference: on a sub-16 GB card graph capture consumes
the headroom the KV cache needs. See
`docs/src/content/docs/reference/hardware-profiles.mdx` for the measured numbers behind each tier,
and note why `saip.yaml` pins no tier by default — hard-coding one would cap a 16 GB dev machine at
the 8 GB tier forever.

## Talking to it

The gateway is the OpenAI-compatible surface; prefer it over the raw engine so adapter selection
and session recording happen.

```bash
curl http://localhost:8000/health                 # gateway up?
curl http://localhost:8000/v1/models              # what is served
curl -X POST http://localhost:8000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"general","messages":[{"role":"user","content":"Three primes above 100."}]}'
```

`/health` and `/v1/models` come from the gateway's core plugin; chat completions stream SSE and
terminate with `[DONE]`. The engine itself answers on `:8081` for direct comparison. The adapter
names in `saip.yaml` (`general`, `coding`, `default-agent`) are what `model` resolves against.

## Adapters (LoRA)

The engine starts with `VLLM_ALLOW_RUNTIME_LORA_UPDATING: "True"`, so the gateway swaps adapters
without a restart. Compiled adapters land in the shared `adapter-cache` volume — mounted at
`/adapters` on the engine and `/app/adapters` on the gateway.

The engine **refuses** adapter contents it does not support: no DoRA vectors, and no
`embed_tokens` / `lm_head` modules. The compiler must not emit those; an adapter that does fails at
load, not at compile.

## Troubleshooting

- **Container restarts with no readable error** — the engine aborted on memory. Re-run
  `npx tsx inference/scripts/generate-engine-args.ts` and read the resolved plan it prints; check
  `docker compose -f inference/docker-compose.yml logs vllm` for the free-vs-total numbers.
- **Exit 2 from the generator** — no profile tier fits the probed GPU, or `saip.yaml` has no
  `profiles:` block. This is the intended outcome; do not "fix" it by raising `vram_ceiling_gib`
  past what the card can hold.
- **Model download hangs or fails on a first boot** — set `SAIP_HF_OFFLINE=1` only once the weights
  are in the `model-cache` volume (`/root/.cache/huggingface` in the container); offline mode with a
  cold cache cannot resolve the pinned revision.
- **Cold load looks like a health-check failure** — first boot includes torch.compile plus CUDA
  graph capture; the engine's health window is deliberately generous, and `logs -f vllm` is how you
  watch it rather than restarting.
- **Tool-calling regressions** — the engine CMD carries `--enable-auto-tool-choice
  --tool-call-parser qwen3_coder` alongside `--trust-remote-code`; changing that belongs in
  `inference/vllm.Dockerfile`, not in a per-run flag.

## Files worth reading before you change this

| File | Why |
|---|---|
| `saip.yaml` | model block, profiles, adapters, host wiring |
| `inference/docker-compose.yml` | the header comment explains the generate-then-up order |
| `inference/scripts/generate-engine-args.ts` | the only place utilization is computed |
| `inference/vllm.Dockerfile` | why `ENTRYPOINT` stays empty (exec-form arrays are not interpolated) |
| `training/docker-compose.yml` | the Axolotl worker and its volumes |
| `inference/README.md` | which plugin owns what |
| `docs/src/content/docs/reference/hardware-profiles.mdx` | measured tiers |
| `docs/src/content/docs/guides/cli-reference.mdx` | the documented flag surface |
