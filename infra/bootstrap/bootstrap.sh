#!/usr/bin/env bash
set -euo pipefail

export AWS_PAGER=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICIES_DIR="${SCRIPT_DIR}/policies"

load_env_file() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 0

  local line key val
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == export\ * ]] && line="${line#export }"
    [[ "$line" == *=* ]] || continue

    key="${line%%=*}"
    val="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"

    if [[ "$val" =~ ^\"(.*)\"$ || "$val" =~ ^\'(.*)\'$ ]]; then
      val="${BASH_REMATCH[1]}"
    fi

    if [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ && -z "${!key:-}" ]]; then
      printf -v "$key" '%s' "$val"
      export "${key?}"
    fi
  done < "$env_file"
}

load_env_file "${SCRIPT_DIR}/.env"

AWS_REGION="${AWS_REGION:-ap-southeast-3}"
GITHUB_REPO="${GITHUB_REPO:-Nnaory/lore}"
ALERT_EMAIL="${ALERT_EMAIL:-}"
BUDGET_USD="${BUDGET_USD:-70}"
ALLOW_NAT_GATEWAY="${ALLOW_NAT_GATEWAY:-false}"

PROJECT="lore"
ENVIRONMENT="prod"

usage() {
  cat <<'EOF'
Error: ALERT_EMAIL is required.

Copy infra/bootstrap/.env.example to infra/bootstrap/.env and edit ALERT_EMAIL,
or pass variables inline:

  ALERT_EMAIL=<email> [AWS_PROFILE=<profile>] [AWS_REGION=ap-southeast-3] \
    [GITHUB_REPO=Nnaory/lore] [BUDGET_USD=70] [ALLOW_NAT_GATEWAY=false] \
    ./infra/bootstrap/bootstrap.sh
EOF
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Error: missing required command '$1'" >&2
    exit 1
  }
}

log() {
  printf '%s\n' "$*"
}

render_policy() {
  local src="$1"
  local dst="$2"
  sed \
    -e "s|<ACCOUNT_ID>|${ACCOUNT_ID}|g" \
    -e "s|<AWS_REGION>|${AWS_REGION}|g" \
    -e "s|<GITHUB_REPO>|${GITHUB_REPO}|g" \
    "$src" > "$dst"

  if [[ "$(basename "$src")" == "lore-guardrail-deny.json" && "$ALLOW_NAT_GATEWAY" == "true" ]]; then
    jq 'del(.Statement[] | select(.Sid == "DenyNatGateway"))' "$dst" > "${dst}.tmp"
    mv "${dst}.tmp" "$dst"
  fi

  jq empty "$dst"
}

json_equal() {
  local a="$1"
  local b="$2"
  [[ "$(jq -cS . "$a")" == "$(jq -cS . "$b")" ]]
}

ensure_sts_v2_token() {
  local current
  current="$(aws iam get-account-summary --query 'SummaryMap.GlobalEndpointTokenVersion' --output text)"
  if [[ "$current" == "2" ]]; then
    log "[ok] STS global endpoint token version already v2Token"
  else
    aws iam set-security-token-service-preferences --global-endpoint-token-version v2Token
    log "[created] STS global endpoint token version set to v2Token"
  fi
}

ensure_oidc_provider() {
  local existing
  existing="$(aws iam list-open-id-connect-providers \
    --query "OpenIDConnectProviderList[?ends_with(Arn, ':oidc-provider/token.actions.githubusercontent.com')].Arn | [0]" \
    --output text)"

  if [[ -n "$existing" && "$existing" != "None" ]]; then
    log "[ok] OIDC provider exists: $existing"
    return
  fi

  aws iam create-open-id-connect-provider \
    --url "https://token.actions.githubusercontent.com" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list "6938fd4d98bab03faadb97b34396831e3780aea1" "1c58a3a8518e8759bf075b76b750d4f2df264fcd" \
    --tags \
      "Key=Project,Value=${PROJECT}" \
      "Key=Environment,Value=${ENVIRONMENT}" \
      "Key=ManagedBy,Value=bootstrap" \
      "Key=Repo,Value=${GITHUB_REPO}" \
      "Key=Component,Value=bootstrap" \
      "Key=Name,Value=lore-github-oidc" >/dev/null
  log "[created] OIDC provider token.actions.githubusercontent.com"
}

ensure_state_bucket() {
  local bucket="lore-tfstate-${ACCOUNT_ID}"

  if aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
    log "[ok] S3 state bucket exists: $bucket"
  else
    if [[ "$AWS_REGION" == "us-east-1" ]]; then
      aws s3api create-bucket --bucket "$bucket" >/dev/null
    else
      aws s3api create-bucket \
        --bucket "$bucket" \
        --region "$AWS_REGION" \
        --create-bucket-configuration "LocationConstraint=${AWS_REGION}" >/dev/null
    fi
    log "[created] S3 state bucket: $bucket"
  fi

  local versioning
  versioning="$(aws s3api get-bucket-versioning --bucket "$bucket" --query 'Status' --output text 2>/dev/null || true)"
  if [[ "$versioning" != "Enabled" ]]; then
    aws s3api put-bucket-versioning \
      --bucket "$bucket" \
      --versioning-configuration Status=Enabled
    log "[updated] S3 versioning enabled on $bucket"
  else
    log "[ok] S3 versioning already Enabled"
  fi

  local sse
  sse="$(aws s3api get-bucket-encryption --bucket "$bucket" \
    --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm' \
    --output text 2>/dev/null || true)"
  if [[ "$sse" != "AES256" ]]; then
    aws s3api put-bucket-encryption \
      --bucket "$bucket" \
      --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
    log "[updated] S3 SSE-S3 encryption enabled on $bucket"
  else
    log "[ok] S3 SSE-S3 encryption already configured"
  fi

  local pab_desired="${TMP_DIR}/pab-desired.json"
  local pab_actual="${TMP_DIR}/pab-actual.json"
  cat > "$pab_desired" <<'EOF'
{
  "BlockPublicAcls": true,
  "IgnorePublicAcls": true,
  "BlockPublicPolicy": true,
  "RestrictPublicBuckets": true
}
EOF
  if aws s3api get-public-access-block --bucket "$bucket" --query 'PublicAccessBlockConfiguration' --output json > "$pab_actual" 2>/dev/null \
    && json_equal "$pab_desired" "$pab_actual"; then
    log "[ok] S3 public access block already configured"
  else
    aws s3api put-public-access-block \
      --bucket "$bucket" \
      --public-access-block-configuration "file://${pab_desired}"
    log "[updated] S3 public access block applied on $bucket"
  fi

  local lc_desired="${TMP_DIR}/lc-desired.json"
  local lc_actual="${TMP_DIR}/lc-actual.json"
  cat > "$lc_desired" <<'EOF'
[
  {
    "ID": "expire-noncurrent-90d",
    "Filter": { "Prefix": "" },
    "Status": "Enabled",
    "NoncurrentVersionExpiration": { "NoncurrentDays": 90 }
  }
]
EOF
  if aws s3api get-bucket-lifecycle-configuration --bucket "$bucket" --query 'Rules' --output json > "$lc_actual" 2>/dev/null \
    && json_equal "$lc_desired" "$lc_actual"; then
    log "[ok] S3 lifecycle noncurrent expiration 90d already configured"
  else
    local lc_payload="${TMP_DIR}/lc-payload.json"
    jq '{ Rules: . }' "$lc_desired" > "$lc_payload"
    aws s3api put-bucket-lifecycle-configuration \
      --bucket "$bucket" \
      --lifecycle-configuration "file://${lc_payload}" >/dev/null
    log "[updated] S3 lifecycle noncurrent expiration 90d applied on $bucket"
  fi

  local tags_desired="${TMP_DIR}/s3-tags-desired.json"
  local tags_actual="${TMP_DIR}/s3-tags-actual.json"
  cat > "$tags_desired" <<EOF
{
  "TagSet": [
    {"Key": "Project", "Value": "${PROJECT}"},
    {"Key": "Environment", "Value": "${ENVIRONMENT}"},
    {"Key": "ManagedBy", "Value": "bootstrap"},
    {"Key": "Repo", "Value": "${GITHUB_REPO}"},
    {"Key": "Component", "Value": "bootstrap"},
    {"Key": "Name", "Value": "${bucket}"}
  ]
}
EOF
  if aws s3api get-bucket-tagging --bucket "$bucket" --output json > "$tags_actual" 2>/dev/null \
    && [[ "$(jq -cS '.TagSet | sort_by(.Key)' "$tags_desired")" == "$(jq -cS '.TagSet | sort_by(.Key)' "$tags_actual")" ]]; then
    log "[ok] S3 bucket tags unchanged"
  else
    aws s3api put-bucket-tagging --bucket "$bucket" --tagging "file://${tags_desired}"
    log "[updated] S3 bucket tags applied on $bucket"
  fi
}

ensure_managed_policy() {
  local name="$1"
  local description="$2"
  local template_file="$3"
  local arn="arn:aws:iam::${ACCOUNT_ID}:policy/${name}"
  local desired="${TMP_DIR}/${name}-desired.json"
  local actual="${TMP_DIR}/${name}-actual.json"

  render_policy "$template_file" "$desired"

  if ! aws iam get-policy --policy-arn "$arn" >/dev/null 2>&1; then
    aws iam create-policy \
      --policy-name "$name" \
      --description "$description" \
      --policy-document "file://${desired}" \
      --tags \
        "Key=Project,Value=${PROJECT}" \
        "Key=Environment,Value=${ENVIRONMENT}" \
        "Key=ManagedBy,Value=bootstrap" \
        "Key=Repo,Value=${GITHUB_REPO}" \
        "Key=Component,Value=iam" \
        "Key=Name,Value=${name}" >/dev/null
    log "[created] IAM managed policy: $name"
    return
  fi

  local default_ver
  default_ver="$(aws iam get-policy --policy-arn "$arn" --query 'Policy.DefaultVersionId' --output text)"
  aws iam get-policy-version \
    --policy-arn "$arn" \
    --version-id "$default_ver" \
    --query 'PolicyVersion.Document' \
    --output json > "$actual"

  if json_equal "$desired" "$actual"; then
    log "[ok] IAM managed policy unchanged: $name"
    return
  fi

  local versions_count oldest_non_default
  versions_count="$(aws iam list-policy-versions --policy-arn "$arn" --query 'length(Versions)' --output text)"
  if [[ "$versions_count" -ge 5 ]]; then
    oldest_non_default="$(aws iam list-policy-versions --policy-arn "$arn" \
      --query 'sort_by(Versions[?IsDefaultVersion==`false`], &CreateDate)[0].VersionId' \
      --output text)"
    aws iam delete-policy-version --policy-arn "$arn" --version-id "$oldest_non_default"
  fi

  aws iam create-policy-version \
    --policy-arn "$arn" \
    --policy-document "file://${desired}" \
    --set-as-default >/dev/null
  log "[updated] IAM managed policy version updated: $name"
}

ensure_role() {
  local role_name="$1"
  local component="$2"
  local description="$3"
  local trust_template="$4"
  local inline_template="$5"
  local managed_arns_csv="$6"

  local trust_desired="${TMP_DIR}/${role_name}-trust-desired.json"
  local trust_actual="${TMP_DIR}/${role_name}-trust-actual.json"
  render_policy "$trust_template" "$trust_desired"

  if ! aws iam get-role --role-name "$role_name" >/dev/null 2>&1; then
    aws iam create-role \
      --role-name "$role_name" \
      --description "$description" \
      --assume-role-policy-document "file://${trust_desired}" \
      --tags \
        "Key=Project,Value=${PROJECT}" \
        "Key=Environment,Value=${ENVIRONMENT}" \
        "Key=ManagedBy,Value=bootstrap" \
        "Key=Repo,Value=${GITHUB_REPO}" \
        "Key=Component,Value=${component}" \
        "Key=Name,Value=${role_name}" >/dev/null
    log "[created] IAM role: $role_name"
  else
    aws iam get-role --role-name "$role_name" --query 'Role.AssumeRolePolicyDocument' --output json > "$trust_actual"
    if json_equal "$trust_desired" "$trust_actual"; then
      log "[ok] IAM role trust policy unchanged: $role_name"
    else
      aws iam update-assume-role-policy \
        --role-name "$role_name" \
        --policy-document "file://${trust_desired}"
      log "[updated] IAM role trust policy updated: $role_name"
    fi
  fi

  if [[ -n "$managed_arns_csv" ]]; then
    local attached
    attached="$(aws iam list-attached-role-policies --role-name "$role_name" --query 'AttachedPolicies[].PolicyArn' --output text)"
    local IFS=','
    local arn
    for arn in $managed_arns_csv; do
      if grep -qwF "$arn" <<<"$attached"; then
        log "[ok] Managed policy already attached to ${role_name}: ${arn##*/}"
      else
        aws iam attach-role-policy --role-name "$role_name" --policy-arn "$arn"
        log "[attached] ${arn##*/} -> ${role_name}"
      fi
    done
  fi

  if [[ -n "$inline_template" ]]; then
    local inline_name="${role_name}-inline"
    local inline_desired="${TMP_DIR}/${inline_name}-desired.json"
    local inline_actual="${TMP_DIR}/${inline_name}-actual.json"
    render_policy "$inline_template" "$inline_desired"

    if aws iam get-role-policy --role-name "$role_name" --policy-name "$inline_name" --query 'PolicyDocument' --output json > "$inline_actual" 2>/dev/null \
      && json_equal "$inline_desired" "$inline_actual"; then
      log "[ok] Inline policy unchanged: $inline_name"
    else
      aws iam put-role-policy \
        --role-name "$role_name" \
        --policy-name "$inline_name" \
        --policy-document "file://${inline_desired}"
      log "[updated] Inline policy applied: $inline_name"
    fi
  fi
}

write_budget_json() {
  local name="$1"
  local dst="$2"
  cat > "$dst" <<EOF
{
  "BudgetName": "${name}",
  "BudgetLimit": {
    "Amount": "${BUDGET_USD}",
    "Unit": "USD"
  },
  "CostTypes": {
    "IncludeTax": true,
    "IncludeSubscription": true,
    "UseBlended": false,
    "IncludeRefund": true,
    "IncludeCredit": false,
    "IncludeUpfront": true,
    "IncludeRecurring": true,
    "IncludeOtherSubscription": true,
    "IncludeSupport": true,
    "IncludeDiscount": true,
    "UseAmortized": false
  },
  "TimeUnit": "MONTHLY",
  "BudgetType": "COST"
}
EOF
}

ensure_monthly_budget() {
  local name="lore-prod-monthly"
  local budget_file="${TMP_DIR}/${name}.json"
  local notif_file="${TMP_DIR}/${name}-notifications.json"
  write_budget_json "$name" "$budget_file"

  cat > "$notif_file" <<EOF
[
  {
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 50,
      "ThresholdType": "PERCENTAGE"
    },
    "Subscribers": [{ "SubscriptionType": "EMAIL", "Address": "${ALERT_EMAIL}" }]
  },
  {
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 80,
      "ThresholdType": "PERCENTAGE"
    },
    "Subscribers": [{ "SubscriptionType": "EMAIL", "Address": "${ALERT_EMAIL}" }]
  },
  {
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 100,
      "ThresholdType": "PERCENTAGE"
    },
    "Subscribers": [{ "SubscriptionType": "EMAIL", "Address": "${ALERT_EMAIL}" }]
  },
  {
    "Notification": {
      "NotificationType": "FORECASTED",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 100,
      "ThresholdType": "PERCENTAGE"
    },
    "Subscribers": [{ "SubscriptionType": "EMAIL", "Address": "${ALERT_EMAIL}" }]
  }
]
EOF

  local current_amount
  if current_amount="$(aws budgets describe-budget --account-id "$ACCOUNT_ID" --budget-name "$name" --query 'Budget.BudgetLimit.Amount' --output text 2>/dev/null)"; then
    if [[ "${current_amount%.*}" == "${BUDGET_USD%.*}" ]]; then
      log "[ok] Budget exists with limit \$${BUDGET_USD}: $name"
    else
      aws budgets update-budget --account-id "$ACCOUNT_ID" --new-budget "file://${budget_file}"
      log "[updated] Budget limit updated to \$${BUDGET_USD}: $name"
    fi
  else
    aws budgets create-budget \
      --account-id "$ACCOUNT_ID" \
      --budget "file://${budget_file}" \
      --notifications-with-subscribers "file://${notif_file}" \
      --resource-tags \
        "Key=Project,Value=${PROJECT}" \
        "Key=Environment,Value=${ENVIRONMENT}" \
        "Key=ManagedBy,Value=bootstrap" \
        "Key=Repo,Value=${GITHUB_REPO}" \
        "Key=Component,Value=budget" \
        "Key=Name,Value=${name}" >/dev/null
    log "[created] Budget: $name (\$${BUDGET_USD}/mo)"
  fi
}

ensure_guardrail_budget() {
  local name="lore-prod-guardrail"
  local budget_file="${TMP_DIR}/${name}.json"
  local def_file="${TMP_DIR}/${name}-action-def.json"
  local subs_file="${TMP_DIR}/${name}-action-subs.json"
  write_budget_json "$name" "$budget_file"

  local current_amount
  if current_amount="$(aws budgets describe-budget --account-id "$ACCOUNT_ID" --budget-name "$name" --query 'Budget.BudgetLimit.Amount' --output text 2>/dev/null)"; then
    if [[ "${current_amount%.*}" == "${BUDGET_USD%.*}" ]]; then
      log "[ok] Budget exists with limit \$${BUDGET_USD}: $name"
    else
      aws budgets update-budget --account-id "$ACCOUNT_ID" --new-budget "file://${budget_file}"
      log "[updated] Budget limit updated to \$${BUDGET_USD}: $name"
    fi
  else
    aws budgets create-budget \
      --account-id "$ACCOUNT_ID" \
      --budget "file://${budget_file}" \
      --resource-tags \
        "Key=Project,Value=${PROJECT}" \
        "Key=Environment,Value=${ENVIRONMENT}" \
        "Key=ManagedBy,Value=bootstrap" \
        "Key=Repo,Value=${GITHUB_REPO}" \
        "Key=Component,Value=budget" \
        "Key=Name,Value=${name}" >/dev/null
    log "[created] Budget: $name (\$${BUDGET_USD}/mo)"
  fi

  local existing_action
  existing_action="$(aws budgets describe-budget-actions-for-budget \
    --account-id "$ACCOUNT_ID" \
    --budget-name "$name" \
    --query "Actions[?ActionType=='APPLY_IAM_POLICY'].ActionId | [0]" \
    --output text 2>/dev/null || true)"

  if [[ -n "$existing_action" && "$existing_action" != "None" ]]; then
    log "[ok] Guardrail budget action already exists: $existing_action"
    return
  fi

  cat > "$def_file" <<EOF
{
  "IamActionDefinition": {
    "PolicyArn": "arn:aws:iam::${ACCOUNT_ID}:policy/lore-deny-new-spend",
    "Roles": ["lore-gh-apply"]
  }
}
EOF
  cat > "$subs_file" <<EOF
[
  {
    "SubscriptionType": "EMAIL",
    "Address": "${ALERT_EMAIL}"
  }
]
EOF

  aws budgets create-budget-action \
    --account-id "$ACCOUNT_ID" \
    --budget-name "$name" \
    --notification-type "ACTUAL" \
    --action-type "APPLY_IAM_POLICY" \
    --action-threshold "ActionThresholdValue=100,ActionThresholdType=PERCENTAGE" \
    --definition "file://${def_file}" \
    --execution-role-arn "arn:aws:iam::${ACCOUNT_ID}:role/lore-budgets-action" \
    --approval-model "AUTOMATIC" \
    --subscribers "file://${subs_file}" >/dev/null
  log "[created] Guardrail budget action on $name (attaches lore-deny-new-spend at 100% ACTUAL)"
}

ensure_anomaly_detection() {
  local monitor_arn
  monitor_arn="$(aws ce get-anomaly-monitors \
    --region us-east-1 \
    --query "AnomalyMonitors[?MonitorDimension=='SERVICE'].MonitorArn | [0]" \
    --output text 2>/dev/null || true)"

  if [[ -z "$monitor_arn" || "$monitor_arn" == "None" ]]; then
    monitor_arn="$(aws ce create-anomaly-monitor \
      --region us-east-1 \
      --anomaly-monitor '{"MonitorName":"lore-service-monitor","MonitorType":"DIMENSIONAL","MonitorDimension":"SERVICE"}' \
      --resource-tags \
        "Key=Project,Value=${PROJECT}" \
        "Key=Environment,Value=${ENVIRONMENT}" \
        "Key=ManagedBy,Value=bootstrap" \
        "Key=Repo,Value=${GITHUB_REPO}" \
        "Key=Component,Value=budget" \
        "Key=Name,Value=lore-service-monitor" \
      --query 'MonitorArn' \
      --output text)"
    log "[created] Cost Anomaly monitor: $monitor_arn"
  else
    log "[ok] Reusing existing Cost Anomaly SERVICE monitor: $monitor_arn"
  fi

  local sub_name="lore-anomaly-alert"
  local existing_sub
  existing_sub="$(aws ce get-anomaly-subscriptions \
    --region us-east-1 \
    --query "AnomalySubscriptions[?SubscriptionName=='${sub_name}'].SubscriptionArn | [0]" \
    --output text 2>/dev/null || true)"

  if [[ -n "$existing_sub" && "$existing_sub" != "None" ]]; then
    log "[ok] Cost Anomaly subscription already exists: $sub_name"
    return
  fi

  local sub_file="${TMP_DIR}/anomaly-sub.json"
  cat > "$sub_file" <<EOF
{
  "SubscriptionName": "${sub_name}",
  "MonitorArnList": ["${monitor_arn}"],
  "Subscribers": [
    {
      "Address": "${ALERT_EMAIL}",
      "Type": "EMAIL"
    }
  ],
  "Frequency": "DAILY",
  "ThresholdExpression": {
    "Dimensions": {
      "Key": "ANOMALY_TOTAL_IMPACT_ABSOLUTE",
      "Values": ["5.0"],
      "MatchOptions": ["GREATER_THAN_OR_EQUAL"]
    }
  }
}
EOF

  aws ce create-anomaly-subscription \
    --region us-east-1 \
    --anomaly-subscription "file://${sub_file}" \
    --resource-tags \
      "Key=Project,Value=${PROJECT}" \
      "Key=Environment,Value=${ENVIRONMENT}" \
      "Key=ManagedBy,Value=bootstrap" \
      "Key=Repo,Value=${GITHUB_REPO}" \
      "Key=Component,Value=budget" \
      "Key=Name,Value=${sub_name}" >/dev/null
  log "[created] Cost Anomaly subscription: $sub_name (>= \$5 daily to $ALERT_EMAIL)"
}

main() {
  require_cmd aws
  require_cmd jq

  if [[ -z "$ALERT_EMAIL" ]]; then
    usage >&2
    exit 1
  fi

  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT

  ACCOUNT_ID="$(aws sts get-caller-identity --query 'Account' --output text)"
  local caller_arn
  caller_arn="$(aws sts get-caller-identity --query 'Arn' --output text)"

  if ! [[ "$ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
    echo "Error: unexpected AWS account id '$ACCOUNT_ID'" >&2
    exit 1
  fi

  log "=== lore bootstrap ==="
  log "Caller : $caller_arn"
  log "Account: $ACCOUNT_ID"
  log "Region : $AWS_REGION"
  log "Repo   : $GITHUB_REPO"
  log "Budget : \$${BUDGET_USD}/mo -> $ALERT_EMAIL"
  log "NAT GW : $ALLOW_NAT_GATEWAY"
  log ""

  ensure_sts_v2_token
  ensure_oidc_provider
  ensure_state_bucket

  ensure_managed_policy \
    "lore-guardrail-deny" \
    "Explicit deny cost and governance guardrails for lore-gh-apply" \
    "${POLICIES_DIR}/lore-guardrail-deny.json"

  ensure_managed_policy \
    "lore-deny-new-spend" \
    "Attached automatically by AWS Budgets at 100% actual spend" \
    "${POLICIES_DIR}/lore-deny-new-spend.json"

  ensure_role \
    "lore-gh-plan" \
    "iam" \
    "GitHub Actions OIDC read-only Terraform plan role for lore" \
    "${POLICIES_DIR}/lore-gh-plan-trust.json" \
    "${POLICIES_DIR}/lore-gh-plan-policy.json" \
    "arn:aws:iam::aws:policy/ReadOnlyAccess"

  ensure_role \
    "lore-gh-apply" \
    "iam" \
    "GitHub Actions OIDC Terraform apply role for lore (guarded)" \
    "${POLICIES_DIR}/lore-gh-apply-trust.json" \
    "${POLICIES_DIR}/lore-gh-apply-policy.json" \
    "arn:aws:iam::${ACCOUNT_ID}:policy/lore-guardrail-deny"

  ensure_role \
    "lore-gh-deploy" \
    "iam" \
    "GitHub Actions OIDC SSM deploy role for lore" \
    "${POLICIES_DIR}/lore-gh-deploy-trust.json" \
    "${POLICIES_DIR}/lore-gh-deploy-policy.json" \
    ""

  ensure_role \
    "lore-budgets-action" \
    "budget" \
    "Execution role for AWS Budgets guardrail action on lore-gh-apply" \
    "${POLICIES_DIR}/lore-budgets-action-trust.json" \
    "${POLICIES_DIR}/lore-budgets-action-policy.json" \
    ""

  ensure_monthly_budget
  ensure_guardrail_budget
  ensure_anomaly_detection

  local plan_arn="arn:aws:iam::${ACCOUNT_ID}:role/lore-gh-plan"
  local apply_arn="arn:aws:iam::${ACCOUNT_ID}:role/lore-gh-apply"
  local deploy_arn="arn:aws:iam::${ACCOUNT_ID}:role/lore-gh-deploy"

  log ""
  log "=== Bootstrap complete ==="
  log "Set GitHub repository variables:"
  log "  gh variable set AWS_REGION --body ${AWS_REGION}"
  log "  gh variable set AWS_ROLE_PLAN_ARN --body ${plan_arn}"
  log "  gh variable set AWS_ROLE_APPLY_ARN --body ${apply_arn}"
  log "  gh variable set AWS_ROLE_DEPLOY_ARN --body ${deploy_arn}"
}

main "$@"
