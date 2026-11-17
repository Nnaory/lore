#!/usr/bin/env bash
set -euo pipefail

export AWS_PAGER=""

REGION="${AWS_REGION:-ap-southeast-3}"
PREFIX="lore-prod"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

echo "Verifying network resources in ${REGION}..."

vpc_cidr="$(aws ec2 describe-vpcs \
  --region "$REGION" \
  --filters "Name=tag:Project,Values=lore" "Name=tag:Name,Values=${PREFIX}-vpc" \
  --query 'Vpcs[0].CidrBlock' --output text)"
[[ "$vpc_cidr" == "10.20.0.0/16" ]] || fail "Expected VPC CIDR 10.20.0.0/16, got '${vpc_cidr}'"
echo "[ok] VPC CIDR: $vpc_cidr"

check_subnet() {
  local name="$1" expected_cidr="$2"
  local actual
  actual="$(aws ec2 describe-subnets \
    --region "$REGION" \
    --filters "Name=tag:Project,Values=lore" "Name=tag:Name,Values=${name}" \
    --query 'Subnets[0].CidrBlock' --output text)"
  [[ "$actual" == "$expected_cidr" ]] || fail "Subnet ${name} expected ${expected_cidr}, got '${actual}'"
  echo "[ok] Subnet ${name}: ${actual}"
}

check_subnet "${PREFIX}-public-a" "10.20.0.0/24"
check_subnet "${PREFIX}-app-a" "10.20.10.0/24"
check_subnet "${PREFIX}-data-a" "10.20.20.0/24"
check_subnet "${PREFIX}-data-b" "10.20.21.0/24"

data_routes="$(aws ec2 describe-route-tables \
  --region "$REGION" \
  --filters "Name=tag:Project,Values=lore" "Name=tag:Name,Values=${PREFIX}-data-rt" \
  --query 'RouteTables[0].Routes[].DestinationCidrBlock' --output text)"
[[ "$data_routes" == "10.20.0.0/16" ]] || fail "Data route table must only have local 10.20.0.0/16, got '${data_routes}'"
echo "[ok] Data route table isolated: ${data_routes}"

s3_ep_state="$(aws ec2 describe-vpc-endpoints \
  --region "$REGION" \
  --filters "Name=tag:Project,Values=lore" "Name=tag:Name,Values=${PREFIX}-s3-endpoint" \
  --query 'VpcEndpoints[0].State' --output text)"
[[ "$s3_ep_state" == "available" ]] || fail "S3 gateway endpoint expected available, got '${s3_ep_state}'"
echo "[ok] S3 gateway endpoint state: ${s3_ep_state}"

sg_ids="$(aws ec2 describe-security-groups \
  --region "$REGION" \
  --filters "Name=tag:Project,Values=lore" \
  --query 'SecurityGroups[].GroupId' --output text)"
[[ -n "$sg_ids" ]] || fail "No security groups found with tag Project=lore"

for sg_id in $sg_ids; do
  ssh_rules="$(aws ec2 describe-security-group-rules \
    --region "$REGION" \
    --filters "Name=group-id,Values=${sg_id}" \
    --query 'SecurityGroupRules[?FromPort==`22` || ToPort==`22`].SecurityGroupRuleId' --output text)"
  [[ -z "$ssh_rules" ]] || fail "Port 22 must not be open on ${sg_id}, found: ${ssh_rules}"
done
echo "[ok] No SSH (port 22) rules found across lore security groups"

rds_sg_id="$(aws ec2 describe-security-groups \
  --region "$REGION" \
  --filters "Name=tag:Project,Values=lore" "Name=tag:Name,Values=${PREFIX}-rds" \
  --query 'SecurityGroups[0].GroupId' --output text)"
[[ -n "$rds_sg_id" && "$rds_sg_id" != "None" ]] || fail "Missing RDS security group"

rds_egress="$(aws ec2 describe-security-group-rules \
  --region "$REGION" \
  --filters "Name=group-id,Values=${rds_sg_id}" \
  --query 'SecurityGroupRules[?IsEgress==`true`].SecurityGroupRuleId' --output text)"
[[ -z "$rds_egress" ]] || fail "RDS SG must have zero egress rules, found: ${rds_egress}"
echo "[ok] RDS security group (${rds_sg_id}) has zero egress rules"

echo "All network checks passed."
