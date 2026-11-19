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

output "nat_instance_id" {
  description = "ID of the NAT instance (when nat_mode = instance)."
  value       = var.nat_mode == "instance" ? aws_instance.nat[0].id : null
}

output "nat_public_ip" {
  description = "Elastic IP address of the NAT instance."
  value       = var.nat_mode == "instance" ? aws_eip.nat[0].public_ip : null
}

output "web_instance_id" {
  description = "ID of the web EC2 instance."
  value       = aws_instance.web.id
}

output "web_public_ip" {
  description = "Elastic IP address of the web instance."
  value       = aws_eip.web.public_ip
}

output "web_app_url" {
  description = "Public URL of the web application."
  value       = var.site_address != "" ? "https://${var.site_address}" : "http://${aws_eip.web.public_ip}"
}

output "api_instance_id" {
  description = "ID of the private API EC2 instance."
  value       = aws_instance.api.id
}

output "api_private_ip" {
  description = "Private IP address of the API instance."
  value       = aws_instance.api.private_ip
}
