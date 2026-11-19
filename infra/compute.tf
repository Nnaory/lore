data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_instance" "nat" {
  count = var.nat_mode == "instance" ? 1 : 0

  ami                    = data.aws_ssm_parameter.al2023.value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public_a.id
  vpc_security_group_ids = [aws_security_group.nat.id]
  iam_instance_profile   = aws_iam_instance_profile.instance["nat"].name
  source_dest_check      = false
  monitoring             = false

  credit_specification {
    cpu_credits = "standard"
  }

  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_size = 8
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = templatefile("${path.module}/user_data_nat.sh.tftpl", {
    app_cidr = aws_subnet.app_a.cidr_block
  })
  user_data_replace_on_change = true

  lifecycle {
    ignore_changes = [ami, associate_public_ip_address]
  }

  tags = {
    Name      = "${local.name_prefix}-nat"
    Component = "nat"
  }

  volume_tags = merge(local.common_tags, {
    Name      = "${local.name_prefix}-nat-root"
    Component = "nat"
  })
}

resource "aws_eip" "nat" {
  count  = var.nat_mode == "instance" ? 1 : 0
  domain = "vpc"

  tags = {
    Name      = "${local.name_prefix}-nat-eip"
    Component = "nat"
  }
}

resource "aws_eip_association" "nat" {
  count = var.nat_mode == "instance" ? 1 : 0

  instance_id   = aws_instance.nat[0].id
  allocation_id = aws_eip.nat[0].id
}

resource "aws_instance" "web" {
  ami                    = data.aws_ssm_parameter.al2023.value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public_a.id
  vpc_security_group_ids = [aws_security_group.web.id]
  iam_instance_profile   = aws_iam_instance_profile.instance["web"].name
  monitoring             = false

  credit_specification {
    cpu_credits = "standard"
  }

  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_size = 12
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = templatefile("${path.module}/user_data_web.sh.tftpl", {
    region         = var.region
    compose_b64    = filebase64("${path.module}/../deploy/web/compose.yml")
    caddyfile_b64  = filebase64("${path.module}/../deploy/web/Caddyfile")
    render_env_b64 = filebase64("${path.module}/../deploy/common/render-env.sh")
    deploy_b64     = filebase64("${path.module}/../deploy/common/deploy.sh")
  })
  user_data_replace_on_change = true

  lifecycle {
    ignore_changes = [ami, associate_public_ip_address]
  }

  tags = {
    Name      = "${local.name_prefix}-web"
    Component = "web"
  }

  volume_tags = merge(local.common_tags, {
    Name      = "${local.name_prefix}-web-root"
    Component = "web"
  })
}

resource "aws_eip" "web" {
  domain = "vpc"

  tags = {
    Name      = "${local.name_prefix}-web-eip"
    Component = "web"
  }
}

resource "aws_eip_association" "web" {
  instance_id   = aws_instance.web.id
  allocation_id = aws_eip.web.id
}

resource "aws_instance" "api" {
  ami                    = data.aws_ssm_parameter.al2023.value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.app_a.id
  private_ip             = "10.20.10.10"
  vpc_security_group_ids = [aws_security_group.api.id]
  iam_instance_profile   = aws_iam_instance_profile.instance["api"].name
  monitoring             = false

  credit_specification {
    cpu_credits = "standard"
  }

  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_size = 12
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = templatefile("${path.module}/user_data_api.sh.tftpl", {
    region         = var.region
    compose_b64    = filebase64("${path.module}/../deploy/api/compose.yml")
    render_env_b64 = filebase64("${path.module}/../deploy/common/render-env.sh")
    deploy_b64     = filebase64("${path.module}/../deploy/common/deploy.sh")
  })
  user_data_replace_on_change = true

  lifecycle {
    ignore_changes = [ami]
  }

  tags = {
    Name      = "${local.name_prefix}-api"
    Component = "api"
  }

  volume_tags = merge(local.common_tags, {
    Name      = "${local.name_prefix}-api-root"
    Component = "api"
  })
}
