"""Shared tagging and cost guardrail policy constants and helpers for CI scripts.

Why: check-tags, check-cost and check-cost-static must agree on the same allowlists, denylist and
limits, so they live here once. The animation feature (spec ai-remotion-animation, design 8.3)
adds the `animation` component, a Lambda size cap and one named log group exception.
`strip_hcl_comments` and `skip_hcl_string` read Terraform source without treating text inside a
quoted string (for example "https://${...}") as a comment.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

REQUIRED_COMMON_TAGS: tuple[str, ...] = ("Project", "Environment", "ManagedBy", "Repo")
ALLOWED_PROJECT_VALUE = "lore"

ALLOWED_COMPONENTS: frozenset[str] = frozenset(
    {"network", "web", "api", "nat", "db", "iam", "budget", "bootstrap", "animation"}
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
        "aws_lambda_function",
        "aws_ecr_repository",
        "aws_s3_bucket",
    }
)

ALLOWED_INSTANCE_TYPES: frozenset[str] = frozenset({"t3.micro"})
ALLOWED_DB_CLASSES: frozenset[str] = frozenset({"db.t3.micro"})
MAX_EC2_VOLUME_GB = 30
MAX_RDS_STORAGE_GB = 50
MAX_LAMBDA_MEMORY_MB = 1536
MAX_LAMBDA_TIMEOUT_S = 60

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
        "aws_lambda_provisioned_concurrency_config",
        "aws_lambda_function_url",
        "aws_apigatewayv2_api",
    }
)

# The one log group that may exist (Requirement 35.9). `aws_cloudwatch_log_group` stays in
# DENYLIST_RESOURCE_TYPES; check-cost and check-cost-static test this exception first and then
# skip the generic denylist check, so every other log group is still rejected.
LOG_GROUP_TYPE = "aws_cloudwatch_log_group"
LOG_GROUP_EXCEPTION: dict[str, str | int] = {
    "address": "aws_cloudwatch_log_group.animation_verifier",
    "resource_name": "animation_verifier",
    "log_group_name": "/aws/lambda/lore-prod-animation-verifier",
    "retention_in_days": 7,
}


def skip_hcl_string(text: str, start: int) -> int:
    """Return the index just after the quoted string that opens at text[start].

    Handles backslash escapes, the escaped sequences `$${` and `%%{`, and `${...}` / `%{...}`
    interpolations, which can contain braces and further quoted strings. An unterminated string
    runs to the end of the text, so callers keep the text instead of dropping it.
    """
    n = len(text)
    i = start + 1
    while i < n:
        ch = text[i]
        if ch == "\\":
            i += 2
        elif ch == '"':
            return i + 1
        elif text.startswith(("$${", "%%{"), i):
            i += 3
        elif text.startswith(("${", "%{"), i):
            i = _skip_hcl_interpolation(text, i + 2)
        else:
            i += 1
    return n


def _skip_hcl_interpolation(text: str, start: int) -> int:
    """Return the index just after the `}` that closes an interpolation body starting at start."""
    n = len(text)
    depth = 1
    i = start
    while i < n:
        ch = text[i]
        if ch == '"':
            i = skip_hcl_string(text, i)
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return n


def strip_hcl_comments(text: str) -> str:
    """Remove `#`, `//` and `/* */` comments from HCL text, leaving quoted strings untouched.

    `//` and `#` inside "..." (for example "https://${var.host}" or a regex) are not comments.
    A line comment is removed up to, not including, its newline. An unterminated `/*` is left
    in place, so a broken file can never hide the resources that follow it.
    """
    out: list[str] = []
    n = len(text)
    i = 0
    while i < n:
        ch = text[i]
        if ch == '"':
            end = skip_hcl_string(text, i)
            out.append(text[i:end])
            i = end
        elif ch == "#" or text.startswith("//", i):
            newline = text.find("\n", i)
            i = n if newline == -1 else newline
        elif text.startswith("/*", i):
            close = text.find("*/", i + 2)
            if close == -1:
                out.append(text[i:])
                break
            i = close + 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def load_plan(plan_path: str | Path) -> list[dict[str, Any]]:
    """Load resource_changes entries from a Terraform plan JSON file."""
    data = json.loads(Path(plan_path).read_text(encoding="utf-8"))
    changes = data.get("resource_changes")
    if not isinstance(changes, list):
        return []
    return [c for c in changes if isinstance(c, dict)]
