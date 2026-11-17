data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

locals {
  ssm_param_prefix = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/lore/${var.environment}"
  instance_roles = {
    web = {
      component   = "web"
      description = "EC2 instance role for lore-prod-web (SSM core and web parameters)"
    }
    api = {
      component   = "api"
      description = "EC2 instance role for lore-prod-api (SSM core, api parameters, and RDS secret)"
    }
    nat = {
      component   = "nat"
      description = "EC2 instance role for lore-prod-nat (SSM core only)"
    }
  }
}

resource "aws_iam_role" "instance" {
  for_each = local.instance_roles

  name               = "${local.name_prefix}-${each.key}-instance"
  description        = each.value.description
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json

  tags = {
    Name      = "${local.name_prefix}-${each.key}-instance"
    Component = each.value.component
  }
}

resource "aws_iam_instance_profile" "instance" {
  for_each = local.instance_roles

  name = "${local.name_prefix}-${each.key}-instance"
  role = aws_iam_role.instance[each.key].name

  tags = {
    Name      = "${local.name_prefix}-${each.key}-instance"
    Component = each.value.component
  }
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  for_each = local.instance_roles

  role       = aws_iam_role.instance[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "web_ssm" {
  statement {
    sid = "ReadWebParameters"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
    ]
    resources = [
      "${local.ssm_param_prefix}/web",
      "${local.ssm_param_prefix}/web/*",
    ]
  }
}

resource "aws_iam_role_policy" "web_ssm" {
  name   = "${local.name_prefix}-web-ssm"
  role   = aws_iam_role.instance["web"].id
  policy = data.aws_iam_policy_document.web_ssm.json
}

data "aws_iam_policy_document" "api_ssm" {
  statement {
    sid = "ReadApiParameters"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
    ]
    resources = [
      "${local.ssm_param_prefix}/api",
      "${local.ssm_param_prefix}/api/*",
    ]
  }
}

resource "aws_iam_role_policy" "api_ssm" {
  name   = "${local.name_prefix}-api-ssm"
  role   = aws_iam_role.instance["api"].id
  policy = data.aws_iam_policy_document.api_ssm.json
}
