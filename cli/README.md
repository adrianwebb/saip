# SAIP CLI

A command-line interface for managing SAIP platform services. Controls Docker Compose
lifecycles, mode switching, and status reporting.

## Architecture

The CLI is a **Cordis application**: each command (`awake`, `sleep`, `down`, `status`) is a
plugin that registers itself with the CLI context, and cross-cutting concerns — config loading,
secrets resolution, Docker orchestration helpers — are injected services from `@saip/shared`.
New commands arrive as new plugins without modifying the dispatcher, and the CLI's view of
adapter resolution uses the exact same shared service the inference gateway uses. See
[Cordis Plugin Model](https://adrianwebb.github.io/saip/explanation/cordis-plugin-model/).

## Commands

### `saip awake`

Stop the training gateway and start the inference gateway.

```bash
saip awake                    # Use default bucket from saip.yaml
saip awake --bucket my-bucket # Override R2 bucket
```

Steps:
1. Validate `saip.yaml` and load `.env`
2. Stop training compose if running (`docker compose -f training/docker-compose.yml down`)
3. Start inference compose (`docker compose -f inference/docker-compose.yml up -d`)
4. Wait for vLLM health check
5. Report status

### `saip sleep`

Stop the inference gateway and start the training gateway.

```bash
saip sleep                    # Use default bucket from saip.yaml
saip sleep --bucket my-bucket # Override R2 bucket
```

Steps:
1. Validate `saip.yaml` and load `.env`
2. Stop inference compose if running (`docker compose -f inference/docker-compose.yml down`)
3. Start training compose (`docker compose -f training/docker-compose.yml up -d`)
4. Report status

### `saip down`

Shut down all running SAIP services.

```bash
saip down
```

Stops both inference and training compose stacks.

### `saip status`

Show current runtime state and vital statistics.

```bash
saip status
```

Output includes:
- Current mode (awake / asleep / down)
- Active adapter count and names
- GPU utilization and VRAM usage
- Connected R2 bucket name
- Service uptime
- Last training job status (if applicable)

## Configuration

The CLI reads `saip.yaml` from the project root and loads secrets from `.env`. No additional
configuration is required.

## Development

```bash
cd cli
pnpm install
pnpm dev          # Run CLI in development mode
pnpm test         # Run tests
pnpm build        # Build for production
```

## Installation

After building, link globally for system-wide access:

```bash
cd cli && pnpm link --global
```
