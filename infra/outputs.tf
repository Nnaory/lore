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

output "vpc_id" {
  description = "ID of the lore VPC."
  value       = aws_vpc.main.id
}

output "public_subnet_id" {
  description = "ID of the public subnet in AZ a."
  value       = aws_subnet.public_a.id
}

output "app_subnet_id" {
  description = "ID of the private application subnet in AZ a."
  value       = aws_subnet.app_a.id
}

output "data_subnet_ids" {
  description = "IDs of the isolated private data subnets."
  value       = [aws_subnet.data_a.id, aws_subnet.data_b.id]
}

output "s3_endpoint_id" {
  description = "ID of the S3 Gateway VPC endpoint."
  value       = aws_vpc_endpoint.s3.id
}
