variable "region" {
  description = "AWS region for lore infrastructure."
  type        = string
  default     = "ap-southeast-3"

  validation {
    condition     = contains(["ap-southeast-3"], var.region)
    error_message = "Only ap-southeast-3 is allowed by the IAM and cost guardrail."
  }
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["prod"], var.environment)
    error_message = "Only the prod environment is configured."
  }
}

variable "instance_type" {
  description = "EC2 instance type for web, api, and nat."
  type        = string
  default     = "t3.micro"

  validation {
    condition     = contains(["t3.micro"], var.instance_type)
    error_message = "Only t3.micro is allowed by cost guardrails."
  }
}

variable "db_instance_class" {
  description = "RDS PostgreSQL instance class."
  type        = string
  default     = "db.t3.micro"

  validation {
    condition     = contains(["db.t3.micro"], var.db_instance_class)
    error_message = "Only db.t3.micro is allowed by cost guardrails."
  }
}

variable "nat_mode" {
  description = "Egress mode for private app subnet: instance (t3.micro) or gateway."
  type        = string
  default     = "instance"

  validation {
    condition     = contains(["instance", "gateway"], var.nat_mode)
    error_message = "nat_mode must be 'instance' or 'gateway'."
  }
}

variable "protect_data" {
  description = "Enable RDS deletion_protection."
  type        = bool
  default     = true
}

variable "site_address" {
  description = "Optional domain name for Caddy TLS (empty serves HTTP on :80)."
  type        = string
  default     = ""
}
