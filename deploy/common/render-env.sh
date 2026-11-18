#!/bin/bash
set -euo pipefail

COMPONENT="${1:-}"
ENVIRONMENT="${ENVIRONMENT:-prod}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-southeast-3}}"
ENV_FILE="${ENV_FILE:-/opt/lore/.env}"

if [[ "$COMPONENT" != "web" && "$COMPONENT" != "api" ]]; then
  echo "Usage: $0 <web|api>" >&2
  exit 2
fi

env_dir="$(dirname "$ENV_FILE")"
mkdir -p "$env_dir"
tmp_file="$(mktemp "${env_dir}/.env.XXXXXX")"
trap 'rm -f "$tmp_file"' EXIT

params_json="$(aws ssm get-parameters-by-path \
  --region "$REGION" \
  --path "/lore/${ENVIRONMENT}/${COMPONENT}/env/" \
  --with-decryption \
  --recursive \
  --output json)"

# Format values as escaped double-quoted pairs so Docker Compose never interpolates '$'.
jq -er '
  def esc: gsub("\\\\"; "\\\\") | gsub("\""; "\\\"") | gsub("\\$"; "\\$");
  (.Parameters // [])
  | sort_by(.Name)
  | .[]
  | (.Name | split("/") | last) as $key
  | (.Value // "") as $val
  | if ($key | test("^[A-Za-z_][A-Za-z0-9_]*$") | not) then
      error("Invalid env variable name from parameter: " + .Name)
    elif ($val | test("[\\r\\n]")) then
      error("Parameter value contains newline: " + .Name)
    else
      "\($key)=\"\($val | esc)\""
    end
' <<<"$params_json" >"$tmp_file"

if [[ "$COMPONENT" == "api" ]]; then
  set +e
  secret_arn="$(aws ssm get-parameter \
    --region "$REGION" \
    --name "/lore/${ENVIRONMENT}/api/config/db_secret_arn" \
    --query 'Parameter.Value' \
    --output text 2>&1)"
  secret_ssm_rc=$?
  set -e

  if [[ $secret_ssm_rc -eq 0 && -n "$secret_arn" && "$secret_arn" != "None" ]]; then
    secret_json="$(aws secretsmanager get-secret-value \
      --region "$REGION" \
      --secret-id "$secret_arn" \
      --query 'SecretString' \
      --output text)"
    jq -er '
      def esc: gsub("\\\\"; "\\\\") | gsub("\""; "\\\"") | gsub("\\$"; "\\$");
      to_entries
      | map(select(.key == "username" or .key == "password"))
      | if length != 2 then error("DB secret missing username or password") else . end
      | map(
          (if .key == "username" then "PGUSER" else "PGPASSWORD" end) as $env_key
          | (.value | tostring) as $val
          | if ($val | test("[\\r\\n]")) then error("DB secret field contains newline")
            else "\($env_key)=\"\($val | esc)\"" end
        )
      | .[]
    ' <<<"$secret_json" >>"$tmp_file"
  elif [[ $secret_ssm_rc -ne 0 && "$secret_arn" != *ParameterNotFound* ]]; then
    echo "[error] gagal membaca /lore/${ENVIRONMENT}/api/config/db_secret_arn: ${secret_arn}" >&2
    exit 1
  fi
fi

set +e
image_tag="$(aws ssm get-parameter \
  --region "$REGION" \
  --name "/lore/${ENVIRONMENT}/${COMPONENT}/release/image_tag" \
  --query 'Parameter.Value' \
  --output text 2>&1)"
tag_rc=$?
set -e

if [[ $tag_rc -ne 0 ]]; then
  if [[ "$image_tag" == *ParameterNotFound* ]]; then
    chmod 600 "$tmp_file"
    mv -f "$tmp_file" "$ENV_FILE"
    exit 10
  fi
  echo "[error] gagal membaca parameter image_tag untuk ${COMPONENT}: ${image_tag}" >&2
  exit 1
fi

if [[ -z "$image_tag" || "$image_tag" == *$'\n'* || "$image_tag" == *$'\r'* || ! "$image_tag" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "[error] nilai image_tag tidak valid untuk ${COMPONENT}" >&2
  exit 1
fi

printf 'APP_IMAGE="ghcr.io/nnaory/lore-%s:%s"\n' "$COMPONENT" "$image_tag" >>"$tmp_file"

chmod 600 "$tmp_file"
mv -f "$tmp_file" "$ENV_FILE"
