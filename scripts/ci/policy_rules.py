"""Shared tagging and cost guardrail policy constants and helpers for CI scripts."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

REQUIRED_COMMON_TAGS: tuple[str, ...] = ("Project", "Environment", "ManagedBy", "Repo")
ALLOWED_PROJECT_VALUE = "lore"

ALLOWED_COMPONENTS: frozenset[str] = frozenset(
    {"network", "web", "api", "nat", "db", "iam", "budget", "bootstrap"}
)

COMPONENT_EXEMPT_TYPES: frozenset[str] = frozenset(
    {
        "aws_vpc_security_group_ingress_rule",
        "aws_vpc_security_group_egress_rule",
        "aws_db_parameter_group",
    }
)

NAME_REQUIRED_TYPES: frozenset[str] = frozenset(
    {
        "aws_vpc",
        "aws_subnet",
        "aws_route_table",
        "aws_internet_gateway",
        "aws_security_group",
        "aws_instance",
        "aws_eip",
        "aws_db_instance",
        "aws_vpc_endpoint",
    }
)

ALLOWED_INSTANCE_TYPES: frozenset[str] = frozenset({"t3.micro"})
ALLOWED_DB_CLASSES: frozenset[str] = frozenset({"db.t3.micro"})
MAX_EC2_VOLUME_GB = 30
MAX_RDS_STORAGE_GB = 50

DENYLIST_RESOURCE_TYPES: frozenset[str] = frozenset(
    {
        "aws_nat_gateway",
        "aws_lb",
        "aws_alb",
        "aws_elasticache_cluster",
        "aws_elasticache_replication_group",
        "aws_elasticsearch_domain",
        "aws_opensearch_domain",
        "aws_wafv2_web_acl",
        "aws_cloudfront_distribution",
        "aws_kms_key",
        "aws_route53_zone",
        "aws_cloudwatch_log_group",
        "aws_rds_cluster",
        "aws_db_proxy",
        "aws_config_configuration_recorder",
        "aws_guardduty_detector",
        "aws_inspector2_enabler",
        "aws_macie2_account",
        "aws_secretsmanager_secret",
    }
)


def load_plan(plan_path: str | Path) -> list[dict[str, Any]]:
    """Load resource_changes entries from a Terraform plan JSON file."""
    data = json.loads(Path(plan_path).read_text(encoding="utf-8"))
    changes = data.get("resource_changes")
    if not isinstance(changes, list):
        return []
    return [c for c in changes if isinstance(c, dict)]
