# Floating IPs feed back into hosts.yaml so `saip --host cloud-*` can reach them.

output "inference_floating_ip" {
  description = "Public IP of the inference VM (for hosts.yaml ssh.host)."
  value       = hyperstack_core_virtual_machine.inference.floating_ip
}

output "training_floating_ip" {
  description = "Public IP of the training VM (for hosts.yaml ssh.host)."
  value       = hyperstack_core_virtual_machine.training.floating_ip
}
