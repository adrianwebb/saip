# SAIP Hyperstack Environment — OpenTofu Module

Provisions the two-GPU cloud deployment: one VM for the inference gateway (+vLLM),
one for the training gateway (+Axolotl). They share state through Cloudflare R2,
so they need no direct peering beyond SSH access that the SAIP CLI uses to drive
Docker Compose.

## ⚠️ Status: scaffolded, not applied

- The `NexGenCloud/hyperstack` Terraform provider is **alpha**; some resources may be unstable.
- Provisioning real GPUs costs money and needs a live Hyperstack account + API key.
- The SAIP hyperstack deployment provider only runs `tofu apply` when explicitly opted in with
  `SAIP_ALLOW_INFRA=true`. Default behavior is plan-only / gated.

This module is committed as the infrastructure contract; treat `apply` as a deliberate,
cost-bearing, maintainer-driven action.

## Prerequisites

1. Install [OpenTofu](https://opentofu.org) (or Terraform ≥ 1.6).
2. Export your Hyperstack API key (the provider reads `API_KEY`):
   ```bash
   export API_KEY=your-hyperstack-api-key
   ```
3. Have an existing environment + keypair, or create them via the provider/console first.

## Usage

```bash
cp terraform.tfvars.example terraform.tfvars   # then edit values
tofu init
tofu plan            # review; safe, no cost
# tofu apply         # ONLY when you intend to provision real, billable GPUs
# tofu destroy       # tear down
```

Outputs `inference_floating_ip` and `training_floating_ip` feed back into the repo-root
`hosts.yaml` so `saip awake --host cloud-inference` can reach the right machines.

## Files

| File | Purpose |
|------|---------|
| `versions.tf` | Provider pins (hyperstack alpha, tls) |
| `variables.tf` | Region, flavors, image, environment/keypair inputs |
| `main.tf` | Two GPU VMs + security-group rules (SSH, 8000, 8001) |
| `outputs.tf` | Floating IPs for hosts.yaml |
| `terraform.tfvars.example` | Non-secret defaults template (no API key here) |
