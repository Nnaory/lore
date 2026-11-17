terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }

  backend "s3" {
    bucket       = "lore-tfstate-875412454941"
    key          = "lore/prod/terraform.tfstate"
    region       = "ap-southeast-3"
    encrypt      = true
    use_lockfile = true
  }
}

locals {
  name_prefix = "lore-${var.environment}"
  common_tags = {
    Project     = "lore"
    Environment = var.environment
    ManagedBy   = "terraform"
    Repo        = "Nnaory/lore"
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = local.common_tags
  }
}
