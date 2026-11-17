output "name_prefix" {
  description = "Standard resource naming prefix."
  value       = local.name_prefix
}

output "region" {
  description = "Target AWS region."
  value       = var.region
}

output "common_tags" {
  description = "Default provider tags applied to Terraform-managed resources."
  value       = local.common_tags
}
