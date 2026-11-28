# Infrastructure for the AI-written Remotion animation feature (spec ai-remotion-animation,
# design 8.1). Every resource here is tagged Component = "animation" and named
# lore-prod-animation-<detail>; the common tags come from the provider default_tags.
#
# This part holds the shared locals and the private S3 bucket that stores the immutable
# animation objects (main.ts, main.js, manifest.json). The browser downloads them straight
# from S3 with a presigned URL (design D-3), so the bucket stays private and only allows
# GET from the site origins. Objects are never overwritten or listed by the app (D-10).
#
# The bucket name carries the account id, which comes from data.aws_caller_identity and is
# never written as a literal. No outputs are added, so the id is not exposed anywhere.
#
# animation_function_name, animation_log_group and animation_ssm_params are defined here
# because the bucket and the API settings share them; they are consumed by the resources
# that follow in this file (verifier Lambda, log group, IAM and SSM parameters).

locals {
  animation_bucket        = "lore-prod-animations-${data.aws_caller_identity.current.account_id}"
  animation_function_name = "${local.name_prefix}-animation-verifier"
  animation_log_group     = "/aws/lambda/${local.animation_function_name}"

  # Browser origins allowed to GET animation objects. Never "*" (Requirement 34.23).
  animation_cors_origins = concat(
    var.site_address != "" ? ["https://${var.site_address}"] : [],
    ["http://${aws_eip.web.public_ip}"],
    var.animation_cors_extra_origins,
  )

  # API settings rendered by render-env.sh. ANIMATION_ENABLED is a separate resource because
  # it needs a precondition on the verifier image tag.
  animation_ssm_params = {
    ANIMATION_RATE_PER_MINUTE_IP    = "4"
    ANIMATION_DAILY_PER_IP          = "30"
    ANIMATION_MAX_CONCURRENT_PER_IP = "1"
    ANIMATION_MAX_CONCURRENT_GLOBAL = "2"
    ANIMATION_MAX_ATTEMPTS          = "4"
    ANIMATION_DEADLINE_MS           = "240000"
    ANIMATION_BUCKET                = local.animation_bucket
    ANIMATION_VERIFIER_FUNCTION     = local.animation_function_name
    AWS_REGION                      = var.region
  }
}

# Private bucket: no versioning, no ACLs, no public access. force_destroy stays false so a
# plan can never silently empty it (CI also blocks deleting any aws_s3_bucket).
resource "aws_s3_bucket" "animations" {
  bucket        = local.animation_bucket
  force_destroy = false

  tags = {
    Name      = "${local.name_prefix}-animation-bucket"
    Component = "animation"
  }
}

resource "aws_s3_bucket_public_access_block" "animations" {
  bucket = aws_s3_bucket.animations.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# BucketOwnerEnforced turns ACLs off, so the bucket owner owns every object.
resource "aws_s3_bucket_ownership_controls" "animations" {
  bucket = aws_s3_bucket.animations.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "animations" {
  bucket = aws_s3_bucket.animations.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "animations_tls" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.animations.arn, "${aws_s3_bucket.animations.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

# depends_on keeps the policy write after the public access block, so S3 does not reject the
# two calls as concurrent changes to the same bucket.
resource "aws_s3_bucket_policy" "animations" {
  bucket = aws_s3_bucket.animations.id
  policy = data.aws_iam_policy_document.animations_tls.json

  depends_on = [aws_s3_bucket_public_access_block.animations]
}

# Exactly one rule: GET only, no allowed_headers, no "*" origin. The presigned URL carries
# its own signature, so the browser sends no custom header.
resource "aws_s3_bucket_cors_configuration" "animations" {
  bucket = aws_s3_bucket.animations.id

  cors_rule {
    allowed_methods = ["GET"]
    allowed_origins = local.animation_cors_origins
    max_age_seconds = 3000
  }
}

# The only rule aborts unfinished multipart uploads after 7 days. Objects never expire
# because they are immutable and referenced by the animation registry.
resource "aws_s3_bucket_lifecycle_configuration" "animations" {
  bucket = aws_s3_bucket.animations.id

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# ---------------------------------------------------------------------------------------------
# Part 2: verifier image repository, log group, network, execution role and Lambda function,
# plus the API instance policy and the SSM parameters (design 8.1, decisions D-1 and D-13).
# ---------------------------------------------------------------------------------------------

# Private image repository for the verifier. Tags are immutable so a pushed sha-xxxxxxx never
# changes meaning, and only the 5 newest images are kept to stay inside the free storage.
resource "aws_ecr_repository" "animation_verifier" {
  name                 = local.animation_function_name
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = {
    Name      = "${local.name_prefix}-animation-ecr"
    Component = "animation"
  }
}

resource "aws_ecr_lifecycle_policy" "animation_verifier" {
  repository = aws_ecr_repository.animation_verifier.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "keep the 5 newest images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 5
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

# The only log group the guardrails allow. It does not depend on the image tag, so the first
# plan (empty tag) already has it and the function can write to it as soon as it is created.
resource "aws_cloudwatch_log_group" "animation_verifier" {
  name              = local.animation_log_group
  retention_in_days = 7

  tags = {
    Name      = "${local.name_prefix}-animation-logs"
    Component = "animation"
  }
}

# No ingress and no egress rule: the verifier gets its input in the invoke payload and returns
# the result in the response, so it never opens a connection. Terraform removes the default
# allow-all egress rule of a new group inside a VPC.
resource "aws_security_group" "animation_verifier" {
  name                   = "${local.name_prefix}-animation-verifier"
  description            = "Verifier Lambda: no ingress and no egress"
  vpc_id                 = aws_vpc.main.id
  revoke_rules_on_delete = true

  tags = {
    Name      = "${local.name_prefix}-animation-verifier-sg"
    Component = "animation"
  }
}

data "aws_iam_policy_document" "animation_lambda_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# No managed policy is attached (no AWSLambdaVPCAccessExecutionRole); the inline policy below
# is the whole permission set.
resource "aws_iam_role" "animation_verifier_exec" {
  name               = "${local.name_prefix}-animation-verifier-exec"
  description        = "Execution role of the animation verifier Lambda (own logs and VPC interfaces)"
  assume_role_policy = data.aws_iam_policy_document.animation_lambda_assume.json

  tags = {
    Name      = "${local.name_prefix}-animation-verifier-exec"
    Component = "animation"
  }
}

data "aws_iam_policy_document" "animation_verifier_exec" {
  # The group is created by Terraform, so the role never needs logs:CreateLogGroup. The ":*"
  # suffix is the log stream level of the ARN, where these two actions are evaluated.
  statement {
    sid       = "WriteOwnLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.animation_verifier.arn}:*"]
  }

  # Resource "*" is required by AWS here: Lambda creates and deletes the VPC network interface
  # with the execution role, and these ec2 actions do not support resource-level restriction
  # for a subnet-scoped interface that does not exist yet (Requirement 34.24).
  statement {
    sid    = "VpcNetworkInterfaces"
    effect = "Allow"
    actions = [
      "ec2:CreateNetworkInterface",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DeleteNetworkInterface",
      "ec2:AssignPrivateIpAddresses",
      "ec2:UnassignPrivateIpAddresses",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "animation_verifier_exec" {
  name   = "${local.name_prefix}-animation-verifier-exec"
  role   = aws_iam_role.animation_verifier_exec.id
  policy = data.aws_iam_policy_document.animation_verifier_exec.json
}

# Created only after the first image has been pushed (two applies, finding T-5): an empty tag
# means no function. image_uri is ignored afterwards because later releases use
# update-function-code, so changing the tag variable later does not touch the function.
# There is no reserved concurrency (T-8), no environment and no function URL; the API invokes
# the function directly with lambda:InvokeFunction.
resource "aws_lambda_function" "animation_verifier" {
  count = var.animation_verifier_image_tag != "" ? 1 : 0

  function_name = local.animation_function_name
  role          = aws_iam_role.animation_verifier_exec.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.animation_verifier.repository_url}:${var.animation_verifier_image_tag}"
  architectures = ["x86_64"]
  memory_size   = 1536
  timeout       = 60

  vpc_config {
    subnet_ids         = [aws_subnet.data_a.id, aws_subnet.data_b.id]
    security_group_ids = [aws_security_group.animation_verifier.id]
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.animation_verifier.name
  }

  depends_on = [aws_iam_role_policy.animation_verifier_exec]

  lifecycle {
    ignore_changes = [image_uri]
  }

  tags = {
    Name      = "${local.name_prefix}-animation-verifier"
    Component = "animation"
  }
}

# Inline policy for the API instance role. The function ARN is built from the name, so the
# policy is valid before the function exists. HEAD on an object uses s3:GetObject (T-2), and
# s3:ListBucket makes a missing key answer 404 instead of 403.
data "aws_iam_policy_document" "api_animation" {
  statement {
    sid       = "AnimationObjects"
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.animations.arn}/animations/*"]
  }

  statement {
    sid       = "AnimationList"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.animations.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["animations/*"]
    }
  }

  statement {
    sid       = "InvokeVerifier"
    effect    = "Allow"
    actions   = ["lambda:InvokeFunction"]
    resources = ["arn:aws:lambda:${var.region}:${data.aws_caller_identity.current.account_id}:function:${local.animation_function_name}"]
  }
}

resource "aws_iam_role_policy" "api_animation" {
  name   = "${local.name_prefix}-api-animation"
  role   = aws_iam_role.instance["api"].id
  policy = data.aws_iam_policy_document.api_animation.json
}

# Nine of the ten API settings. They sit under the api prefix, so render-env.sh and the api
# instance policy pick them up without any change under deploy/ (T-6).
resource "aws_ssm_parameter" "animation_env" {
  for_each = local.animation_ssm_params

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

# The tenth setting is separate so it can refuse to turn the feature on while the verifier
# image is missing (Requirement 36.12). Turning it on is an in-place update of this parameter
# only.
resource "aws_ssm_parameter" "animation_enabled" {
  name      = "/lore/${var.environment}/api/env/ANIMATION_ENABLED"
  type      = "String"
  tier      = "Standard"
  value     = var.animation_enabled ? "true" : "false"
  overwrite = true

  lifecycle {
    precondition {
      condition     = !var.animation_enabled || var.animation_verifier_image_tag != ""
      error_message = "animation_enabled requires animation_verifier_image_tag."
    }
  }

  tags = {
    Name      = "${local.name_prefix}-api-env-animation_enabled"
    Component = "api"
  }
}
