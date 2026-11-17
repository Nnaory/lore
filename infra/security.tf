resource "aws_security_group" "web" {
  name                   = "${local.name_prefix}-web"
  description            = "Web instance: public HTTP/HTTPS ingress, HTTPS egress, and proxy to api"
  vpc_id                 = aws_vpc.main.id
  revoke_rules_on_delete = true

  tags = {
    Name      = "${local.name_prefix}-web"
    Component = "web"
  }
}

resource "aws_security_group" "api" {
  name                   = "${local.name_prefix}-api"
  description            = "API instance: private ingress from web, egress via NAT and to RDS"
  vpc_id                 = aws_vpc.main.id
  revoke_rules_on_delete = true

  tags = {
    Name      = "${local.name_prefix}-api"
    Component = "api"
  }
}

resource "aws_security_group" "nat" {
  name                   = "${local.name_prefix}-nat"
  description            = "NAT instance: HTTPS egress forwarding from private app subnet"
  vpc_id                 = aws_vpc.main.id
  revoke_rules_on_delete = true

  tags = {
    Name      = "${local.name_prefix}-nat"
    Component = "nat"
  }
}

resource "aws_security_group" "rds" {
  name                   = "${local.name_prefix}-rds"
  description            = "RDS PostgreSQL: ingress from api only, no egress"
  vpc_id                 = aws_vpc.main.id
  revoke_rules_on_delete = true

  tags = {
    Name      = "${local.name_prefix}-rds"
    Component = "db"
  }
}

resource "aws_vpc_security_group_ingress_rule" "web_http" {
  security_group_id = aws_security_group.web.id
  description       = "HTTP and ACME HTTP-01"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "web_https" {
  security_group_id = aws_security_group.web.id
  description       = "HTTPS via Caddy"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "web_https" {
  security_group_id = aws_security_group.web.id
  description       = "GHCR, SSM, Lets Encrypt, and transitional Gemini calls"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "web_to_api" {
  security_group_id            = aws_security_group.web.id
  description                  = "Reverse proxy /api/v1/* to api"
  ip_protocol                  = "tcp"
  from_port                    = 8000
  to_port                      = 8000
  referenced_security_group_id = aws_security_group.api.id
}

resource "aws_vpc_security_group_ingress_rule" "api_from_web" {
  security_group_id            = aws_security_group.api.id
  description                  = "FastAPI port 8000 from web only"
  ip_protocol                  = "tcp"
  from_port                    = 8000
  to_port                      = 8000
  referenced_security_group_id = aws_security_group.web.id
}

resource "aws_vpc_security_group_egress_rule" "api_https" {
  security_group_id = aws_security_group.api.id
  description       = "Gemini, GHCR, and SSM via NAT"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "api_to_rds" {
  security_group_id            = aws_security_group.api.id
  description                  = "PostgreSQL to RDS"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.rds.id
}

resource "aws_vpc_security_group_ingress_rule" "nat_from_app" {
  security_group_id = aws_security_group.nat.id
  description       = "HTTPS egress from private app subnet"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = aws_subnet.app_a.cidr_block
}

resource "aws_vpc_security_group_egress_rule" "nat_https" {
  security_group_id = aws_security_group.nat.id
  description       = "Forwarded HTTPS to internet"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_api" {
  security_group_id            = aws_security_group.rds.id
  description                  = "PostgreSQL from api only"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.api.id
}
