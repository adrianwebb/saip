# Two GPU virtual machines: one runs the inference gateway + vLLM, the other
# runs the training gateway + Axolotl. They share state through Cloudflare R2,
# so they need no direct peering beyond SSH access for SAIP to drive compose.

resource "hyperstack_core_virtual_machine" "inference" {
  name               = "saip-inference"
  environment_name   = var.environment_name
  key_name           = var.keypair_name
  image_name         = var.image_name
  flavor_name        = var.inference_flavor
  user_data          = ""
  assign_floating_ip = true
}

resource "hyperstack_core_virtual_machine" "training" {
  name               = "saip-training"
  environment_name   = var.environment_name
  key_name           = var.keypair_name
  image_name         = var.image_name
  flavor_name        = var.training_flavor
  user_data          = ""
  assign_floating_ip = true
}

# --- Security group rules ---------------------------------------------------
# SSH for the SAIP CLI/providers; 8000 (inference) and 8001 (training) are the
# API ports. Tighten remote_ip_prefix in real deployments (VPN / allowlist).

resource "hyperstack_core_virtual_machine_sg_rule" "inference_ssh" {
  virtual_machine_id = hyperstack_core_virtual_machine.inference.id
  direction          = "ingress"
  ethertype          = "IPv4"
  port_range_min     = 22
  port_range_max     = 22
  protocol           = "tcp"
  remote_ip_prefix   = "0.0.0.0/0"
}

resource "hyperstack_core_virtual_machine_sg_rule" "inference_api" {
  virtual_machine_id = hyperstack_core_virtual_machine.inference.id
  direction          = "ingress"
  ethertype          = "IPv4"
  port_range_min     = 8000
  port_range_max     = 8000
  protocol           = "tcp"
  remote_ip_prefix   = "0.0.0.0/0"
}

resource "hyperstack_core_virtual_machine_sg_rule" "training_ssh" {
  virtual_machine_id = hyperstack_core_virtual_machine.training.id
  direction          = "ingress"
  ethertype          = "IPv4"
  port_range_min     = 22
  port_range_max     = 22
  protocol           = "tcp"
  remote_ip_prefix   = "0.0.0.0/0"
}

resource "hyperstack_core_virtual_machine_sg_rule" "training_api" {
  virtual_machine_id = hyperstack_core_virtual_machine.training.id
  direction          = "ingress"
  ethertype          = "IPv4"
  port_range_min     = 8001
  port_range_max     = 8001
  protocol           = "tcp"
  remote_ip_prefix   = "0.0.0.0/0"
}
