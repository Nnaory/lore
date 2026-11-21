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
    PGHOST         = aws_db_instance.db.address
    PGPORT         = tostring(aws_db_instance.db.port)
    PGDATABASE     = aws_db_instance.db.db_name
    PGSSLMODE      = "require"
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

# Gemini key for the API. Terraform only creates the parameter with a placeholder
# and never manages the value (ignore_changes), so the real key is not in tfstate.
# Set it once by hand after the first apply (docs/infra/09-runbook.md):
#   aws ssm put-parameter --name /lore/<env>/api/env/GOOGLE_API_KEY \
#     --type SecureString --overwrite --value '<key>'
# The default AWS-managed key (alias/aws/ssm) is used, so no KMS resource or policy
# is needed and there is no extra cost. render-env.sh already reads with decryption.
resource "aws_ssm_parameter" "api_google_api_key" {
  name      = "/lore/${var.environment}/api/env/GOOGLE_API_KEY"
  type      = "SecureString"
  tier      = "Standard"
  value     = "__SET_ME__"
  overwrite = true

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Name      = "${local.name_prefix}-api-env-google_api_key"
    Component = "api"
  }
}

resource "aws_ssm_parameter" "api_db_secret_arn" {
  name      = "/lore/${var.environment}/api/config/db_secret_arn"
  type      = "String"
  tier      = "Standard"
  value     = aws_db_instance.db.master_user_secret[0].secret_arn
  overwrite = true

  tags = {
    Name      = "${local.name_prefix}-api-config-db-secret-arn"
    Component = "api"
  }
}
