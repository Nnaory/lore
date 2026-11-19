resource "aws_db_subnet_group" "db" {
  name       = "${local.name_prefix}-db-subnets"
  subnet_ids = [aws_subnet.data_a.id, aws_subnet.data_b.id]

  tags = {
    Name      = "${local.name_prefix}-db-subnets"
    Component = "db"
  }
}

resource "aws_db_parameter_group" "pg16" {
  name   = "${local.name_prefix}-pg16"
  family = "postgres16"

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "immediate"
  }

  tags = {
    Name      = "${local.name_prefix}-pg16"
    Component = "db"
  }
}

resource "aws_db_instance" "db" {
  identifier        = "${local.name_prefix}-db"
  engine            = "postgres"
  engine_version    = "16"
  instance_class    = var.db_instance_class
  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true

  db_name                     = "lore"
  username                    = "lore_admin"
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.db.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  parameter_group_name   = aws_db_parameter_group.pg16.name
  publicly_accessible    = false
  multi_az               = false

  backup_retention_period    = 7
  backup_window              = "18:30-19:30"
  maintenance_window         = "sun:20:00-sun:21:00"
  copy_tags_to_snapshot      = true
  auto_minor_version_upgrade = true
  apply_immediately          = false
  deletion_protection        = var.protect_data
  skip_final_snapshot        = false
  final_snapshot_identifier  = "${local.name_prefix}-db-final"

  performance_insights_enabled = false
  monitoring_interval          = 0

  tags = {
    Name      = "${local.name_prefix}-db"
    Component = "db"
  }
}
