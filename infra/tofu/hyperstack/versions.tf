terraform {
  required_version = ">= 1.6.0"

  # OpenTofu is Terraform-compatible and consumes this provider block unchanged.
  required_providers {
    hyperstack = {
      source  = "NexGenCloud/hyperstack"
      version = "0.2.2-alpha"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}
