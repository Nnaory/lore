#!/usr/bin/env bash
set -euo pipefail

export AWS_PAGER=""

REGION="${AWS_REGION:-ap-southeast-3}"
PREFIX="lore-prod"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

echo "Verifying NAT instance, app route, and SSM status in ${REGION}..."

nat_id="$(aws ec2 describe-instances \
  --region "$REGION" \
  --filters "Name=tag:Project,Values=lore" "Name=tag:Name,Values=${PREFIX}-nat" "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)"
[[ -n "$nat_id" && "$nat_id" != "None" ]] || fail "Running ${PREFIX}-nat instance not found"

nat_info="$(aws ec2 describe-instances --region "$REGION" --instance-ids "$nat_id" \
  --query 'Reservations[0].Instances[0].[InstanceType,SourceDestCheck,NetworkInterfaces[0].NetworkInterfaceId,PublicIpAddress]' --output text)"
read -r nat_type src_dst_check nat_eni nat_ip <<<"$nat_info"

[[ "$nat_type" == "t3.micro" ]] || fail "NAT instance type expected t3.micro, got '${nat_type}'"
[[ "$src_dst_check" == "False" ]] || fail "NAT SourceDestCheck must be False, got '${src_dst_check}'"
[[ -n "$nat_ip" && "$nat_ip" != "None" ]] || fail "NAT instance missing public Elastic IP"
echo "[ok] NAT instance ${nat_id}: type=${nat_type}, SourceDestCheck=${src_dst_check}, ENI=${nat_eni}, EIP=${nat_ip}"

# JMESPath uses literal backticks inside single-quoted --query filters.
# shellcheck disable=SC2016
app_rt_target="$(aws ec2 describe-route-tables \
  --region "$REGION" \
  --filters "Name=tag:Project,Values=lore" "Name=tag:Name,Values=${PREFIX}-app-rt" \
  --query 'RouteTables[0].Routes[?DestinationCidrBlock==`0.0.0.0/0`].NetworkInterfaceId | [0]' --output text)"
[[ "$app_rt_target" == "$nat_eni" ]] || fail "App route 0.0.0.0/0 expected ${nat_eni}, got '${app_rt_target}'"
echo "[ok] App route table 0.0.0.0/0 points to ${app_rt_target}"

ssm_status="$(aws ssm describe-instance-information \
  --region "$REGION" \
  --filters "Key=InstanceIds,Values=${nat_id}" \
  --query 'InstanceInformationList[0].PingStatus' --output text)"
[[ "$ssm_status" == "Online" ]] || fail "NAT instance SSM PingStatus expected Online, got '${ssm_status}'"
echo "[ok] NAT instance SSM PingStatus: ${ssm_status}"

echo "All NAT and SSM checks passed."
