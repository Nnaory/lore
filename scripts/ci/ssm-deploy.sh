#!/bin/bash
set -euo pipefail

COMPONENT="${1:-}"
NEW_TAG="${2:-}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-southeast-3}}"
ENVIRONMENT="${ENVIRONMENT:-prod}"
APP_URL="${APP_URL:-}"
REPO_TAG="${GITHUB_REPOSITORY:-Nnaory/lore}"
PARAM_NAME="/lore/${ENVIRONMENT}/${COMPONENT}/release/image_tag"

fail() {
  echo "[fail] $*" >&2
  exit 1
}

validate_inputs() {
  if [[ "$COMPONENT" != "web" && "$COMPONENT" != "api" ]]; then
    echo "Usage: $0 <web|api> <image_tag>" >&2
    exit 2
  fi
  if [[ -z "$NEW_TAG" || "$NEW_TAG" == *$'\n'* || "$NEW_TAG" == *$'\r'* || ! "$NEW_TAG" =~ ^[A-Za-z0-9._-]+$ ]]; then
    fail "Invalid image tag: '${NEW_TAG}'"
  fi
  if [[ -z "$APP_URL" ]]; then
    fail "APP_URL environment variable is required for smoke testing"
  fi
}

get_previous_tag() {
  local out rc
  set +e
  out="$(aws ssm get-parameter \
    --region "$REGION" \
    --name "$PARAM_NAME" \
    --query 'Parameter.Value' \
    --output text 2>&1)"
  rc=$?
  set -e

  if [[ $rc -eq 0 ]]; then
    if [[ "$out" != "None" ]]; then
      printf '%s' "$out"
    fi
    return 0
  fi
  if [[ "$out" == *ParameterNotFound* ]]; then
    return 0
  fi
  fail "Failed to read ${PARAM_NAME}: ${out}"
}

write_image_tag() {
  local tag="$1"
  local tag_if_new="$2"

  aws ssm put-parameter \
    --region "$REGION" \
    --name "$PARAM_NAME" \
    --type String \
    --value "$tag" \
    --overwrite >/dev/null

  if [[ "$tag_if_new" == "true" ]]; then
    aws ssm add-tags-to-resource \
      --region "$REGION" \
      --resource-type Parameter \
      --resource-id "$PARAM_NAME" \
      --tags \
      "Key=Project,Value=lore" \
      "Key=Environment,Value=${ENVIRONMENT}" \
      "Key=Component,Value=${COMPONENT}" \
      "Key=ManagedBy,Value=github-actions" \
      "Key=Repo,Value=${REPO_TAG}"
  fi
}

resolve_instance_id() {
  local ids count
  ids="$(aws ec2 describe-instances \
    --region "$REGION" \
    --filters \
    "Name=tag:Project,Values=lore" \
    "Name=tag:Environment,Values=${ENVIRONMENT}" \
    "Name=tag:Component,Values=${COMPONENT}" \
    "Name=instance-state-name,Values=running" \
    --query 'Reservations[].Instances[].InstanceId' \
    --output text)"

  count="$(wc -w <<<"$ids" | tr -d ' ')"
  if [[ "$count" -ne 1 || "$ids" == "None" ]]; then
    fail "Expected exactly 1 running instance for component '${COMPONENT}', found ${count}: '${ids}'"
  fi
  printf '%s' "$ids" | tr -d '[:space:]'
}

run_remote_deploy() {
  local instance_id="$1"
  local comment="$2"
  local cmd_id inv_json inv_rc status stdout_txt stderr_txt

  cmd_id="$(aws ssm send-command \
    --region "$REGION" \
    --document-name AWS-RunShellScript \
    --instance-ids "$instance_id" \
    --comment "$comment" \
    --parameters "commands=[\"/opt/lore/deploy.sh ${COMPONENT}\"]" \
    --query 'Command.CommandId' \
    --output text)"

  echo "[info] SSM command ${cmd_id} sent to ${instance_id} (${comment})"

  for attempt in $(seq 1 120); do
    set +e
    inv_json="$(aws ssm get-command-invocation \
      --region "$REGION" \
      --command-id "$cmd_id" \
      --instance-id "$instance_id" \
      --output json 2>&1)"
    inv_rc=$?
    set -e

    if [[ $inv_rc -ne 0 ]]; then
      if [[ "$inv_json" == *InvocationDoesNotExist* && "$attempt" -le 6 ]]; then
        sleep 5
        continue
      fi
      echo "[error] get-command-invocation failed: ${inv_json}" >&2
      return 1
    fi

    status="$(jq -r '.Status' <<<"$inv_json")"
    case "$status" in
      Pending | InProgress | Delayed)
        sleep 5
        ;;
      Success)
        stdout_txt="$(jq -r '.StandardOutputContent // ""' <<<"$inv_json")"
        stderr_txt="$(jq -r '.StandardErrorContent // ""' <<<"$inv_json")"
        if [[ -n "$stdout_txt" ]]; then echo "$stdout_txt"; fi
        if [[ -n "$stderr_txt" ]]; then echo "$stderr_txt" >&2; fi
        return 0
        ;;
      *)
        echo "[error] SSM command finished with status '${status}'" >&2
        stdout_txt="$(jq -r '.StandardOutputContent // ""' <<<"$inv_json")"
        stderr_txt="$(jq -r '.StandardErrorContent // ""' <<<"$inv_json")"
        if [[ -n "$stdout_txt" ]]; then echo "$stdout_txt"; fi
        if [[ -n "$stderr_txt" ]]; then echo "$stderr_txt" >&2; fi
        return 1
        ;;
    esac
  done

  echo "[error] Timed out waiting for SSM command ${cmd_id}" >&2
  return 1
}

smoke_test() {
  local base="${APP_URL%/}"
  if [[ "$COMPONENT" == "web" ]]; then
    echo "[info] Running smoke test on ${base}/ and ${base}/api/health"
    curl --fail --silent --show-error --retry 10 --retry-delay 6 --retry-connrefused --retry-all-errors --max-time 15 "${base}/" >/dev/null
    curl --fail --silent --show-error --retry 5 --retry-delay 3 --retry-connrefused --retry-all-errors --max-time 15 "${base}/api/health" >/dev/null
  else
    echo "[info] Running smoke test on ${base}/api/v1/health"
    curl --fail --silent --show-error --retry 10 --retry-delay 6 --retry-connrefused --retry-all-errors --max-time 15 "${base}/api/v1/health" >/dev/null
  fi
  echo "[ok] Smoke test passed for ${COMPONENT}"
}

rollback() {
  local instance_id="$1"
  local prev_tag="$2"
  if [[ -z "$prev_tag" ]]; then
    echo "[warn] No previous release tag available to roll back to." >&2
    return 1
  fi
  echo "[warn] Rolling back ${COMPONENT} to ${prev_tag}..." >&2
  write_image_tag "$prev_tag" "false"
  run_remote_deploy "$instance_id" "rollback ${COMPONENT} ${prev_tag}"
}

main() {
  validate_inputs
  local prev_tag instance_id is_new="false"

  prev_tag="$(get_previous_tag)"
  [[ -z "$prev_tag" ]] && is_new="true"
  instance_id="$(resolve_instance_id)"

  echo "[info] Deploying ${COMPONENT}:${NEW_TAG} to ${instance_id} (previous=${prev_tag:-none})"
  write_image_tag "$NEW_TAG" "$is_new"

  if ! run_remote_deploy "$instance_id" "deploy ${COMPONENT} ${NEW_TAG}"; then
    rollback "$instance_id" "$prev_tag" || true
    exit 1
  fi

  if ! smoke_test; then
    rollback "$instance_id" "$prev_tag" || true
    exit 1
  fi
}

main
