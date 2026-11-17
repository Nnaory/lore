locals {
  ai_models = "gemini-3.5-flash-lite,gemini-3.7-flash,gemini-3.8-flash"

  web_ssm_params = merge(
    {
      AI_PROVIDER    = "google"
      AI_MODEL       = local.ai_models
      AI_TIMEOUT_MS  = "300000"
      AI_DEADLINE_MS = "300000"
      API_UPSTREAM   = "http://10.20.10.10:8000"
    },
    var.site_address != "" ? { SITE_ADDRESS = var.site_address } : {}
  )

  api_ssm_params = {
    AI_PROVIDER    = "google"
    AI_MODEL       = local.ai_models
    AI_TIMEOUT_MS  = "300000"
    AI_DEADLINE_MS = "300000"
  }
}

resource "aws_ssm_parameter" "web_env" {
  for_each = local.web_ssm_params

  name      = "/lore/${var.environment}/web/env/${each.key}"
  type      = "String"
  tier      = "Standard"
  value     = each.value
  overwrite = true

  tags = {
    Name      = "${local.name_prefix}-web-env-${lower(each.key)}"
    Component = "web"
  }
}

resource "aws_ssm_parameter" "api_env" {
  for_each = local.api_ssm_params

  name      = "/lore/${var.environment}/api/env/${each.key}"
  type      = "String"
  tier      = "Standard"
  value     = each.value
  overwrite = true

  tags = {
    Name      = "${local.name_prefix}-api-env-${lower(each.key)}"
    Component = "api"
  }
}
