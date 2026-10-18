# Variables for the SAIP 2-GPU Hyperstack environment.
# Secret VALUES are never here — the provider reads API_KEY from the environment.

variable "region" {
  description = "Hyperstack region (e.g. CANADA-1, IRELAND-1)."
  type        = string
  default     = "CANADA-1"
}

variable "environment_name" {
  description = "Existing Hyperstack environment to deploy into."
  type        = string
}

variable "keypair_name" {
  description = "Existing keypair name for SSH access."
  type        = string
}

variable "image_name" {
  description = "VM image with Docker + CUDA drivers."
  type        = string
  default     = "Ubuntu Server 22.04 LTS R535 CUDA 12.2 with Docker"
}

variable "inference_flavor" {
  description = "GPU flavor for the inference node (see Hyperstack flavors)."
  type        = string
  default     = "n3-H100x1"
}

variable "training_flavor" {
  description = "GPU flavor for the training node."
  type        = string
  default     = "n3-H100x1"
}
