#!/usr/bin/env bash
# Release script for the animation verifier Lambda image (design 8.4 and 8.5; Requirements 37.5 to
# 37.8, 37.11 to 37.14, 36.3 step 3, 34.20).
#
# Why: the verifier runs as a container image on Lambda. A release builds the image (or reuses one
# that is already in ECR), points the function at it, proves the new code works by invoking it with
# two known fixtures, and only then records the tag in SSM. A failed check puts the previous tag
# back, so the function never stays on an image that did not pass.
#
# Usage: scripts/ci/verifier-release.sh build-and-release [tag]
#   tag   empty (default): release sha-<first 7 characters of $GITHUB_SHA>, building and pushing it
#         unless that tag is already in ECR (tags are immutable, so a pushed tag never changes).
#         sha-<7 hex>: roll back to a tag that must already be in ECR; nothing is built.
# Env:    AWS_REGION (default ap-southeast-3), ENVIRONMENT (default prod), GITHUB_SHA,
#         GITHUB_REPOSITORY (the Repo tag of a new SSM parameter).
# Needs:  aws, docker (buildx) and jq; run from any directory (the script moves to the repo root).
# Exit:   0 released, or the first release with no function yet; 1 any failure; 2 bad usage.
#
# Order of work (every step is a Requirement 37 criterion):
#   1. The tag is validated against ^sha-[0-9a-f]{7}$ BEFORE the first `aws` call (37.12).
#   2. The two smoke payloads are built from animation-verifier/fixtures/release-smoke.json, so a
#      broken manifest stops the run before anything is pushed or changed.
#   3. The account id comes from `sts get-caller-identity` and is masked in the Actions log at once.
#   4. A rollback tag must exist in ECR (37.12). A new tag is built and pushed unless it exists
#      (37.5), as one linux/amd64 image with no provenance or SBOM, because Lambda rejects an OCI
#      image index (37.13).
#   5. No function yet (ResourceNotFoundException): print [warn], write the tag to
#      /lore/<env>/verifier/release/image_tag, exit 0 (37.11). Terraform creates the function in the
#      next infra PR from that tag.
#   6. Otherwise: read previous_tag, update-function-code, wait function-updated, invoke the good
#      and the bad fixture (37.6). Any failure puts previous_tag back and exits 1 without writing
#      the parameter (37.7).
#   7. Success writes the parameter with --overwrite, and its tags when the parameter is new (37.6).
#
# Output: [info]/[ok] on stdout, [warn]/[error]/[fail] on stderr. The log never holds source code,
# payloads, passwords, or the account id (only the masked ::add-mask:: line carries it).
set -euo pipefail

MODE="${1:-}"
TAG_ARG="${2:-}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-southeast-3}}"
ENVIRONMENT="${ENVIRONMENT:-prod}"
REPO_TAG="${GITHUB_REPOSITORY:-Nnaory/lore}"
FUNCTION_NAME="lore-${ENVIRONMENT}-animation-verifier"
ECR_REPOSITORY="$FUNCTION_NAME"
PARAM_NAME="/lore/${ENVIRONMENT}/verifier/release/image_tag"
TAG_PATTERN='^sha-[0-9a-f]{7}$'
PATH_PATTERN='^[A-Za-z0-9._/-]+$'

# Relative to the repository root (the script moves there before it reads any of these).
VERIFIER_DIR="animation-verifier"
FIXTURES_DIR="${VERIFIER_DIR}/fixtures"
SMOKE_MANIFEST="${FIXTURES_DIR}/release-smoke.json"
CONTRACT_FILE="${VERIFIER_DIR}/contract/animation-contract.json"

TAG=""
REGISTRY=""
IMAGE_REPO=""
WORK=""
CONTRACT_VERSION=""
EXPECTED_BAD="[]"

fail() {
  echo "[fail] $*" >&2
  exit 1
}

usage() {
  echo "Usage: $0 build-and-release [tag]" >&2
  echo "  tag  optional rollback tag sha-<7 hex>; it must already be in ECR" >&2
  exit 2
}

info() {
  echo "[info] $*"
}

warn() {
  echo "[warn] $*" >&2
}

cleanup() {
  local rc=$?
  trap - EXIT
  if [[ -n "$WORK" ]]; then
    rm -rf -- "$WORK"
  fi
  exit "$rc"
}

# ---- jq programs ----

# Request payload, the same rule as scripts/ci/verifier-rie-check.sh (JQ_PAYLOAD) and
# animation-verifier/tests/support/corpus.ts. Arguments: $source (raw file text), $companion
# (slurped companion JSON, [] when there is none), $contract_version.
JQ_PAYLOAD="$(
  cat <<'JQ'
($companion[0] // {}) as $c
| { source: $source,
    kind: ($c.kind // "lesson"),
    required_tokens: ($c.required_tokens // []),
    forbidden_tokens: ($c.forbidden_tokens // []),
    contract_version: $contract_version }
JQ
)"

# Verdict for one response. Input: the invoke response. Arguments: $kind ("good" or "bad") and
# $expected (the codes the bad fixture must report). Output: "" when the response is right, else
# one line saying why not. Only Diagnostic codes are named, never source text.
JQ_VERDICT="$(
  cat <<'JQ'
if (type != "object") or ((.ok | type) != "boolean") or ((.diagnostics | type) != "array")
then "the response is not a Verifier_Result"
else
  [.diagnostics[] | select(type == "object") | .code | select(type == "string")] as $got
  | ($got | map(select(startswith("VERIFIER_"))) | unique) as $internal
  | if ($internal | length) > 0
    then "the verifier reported its own failure: " + ($internal | join(","))
    elif $kind == "good"
    then (if .ok == true then ""
          else "expected ok=true, got ok=false with codes: " + ($got | unique | join(",")) end)
    elif .ok != false
    then "expected ok=false, got ok=true"
    else
      ($expected - $got) as $missing
      | (if ($missing | length) == 0 then ""
         else "codes missing from the result: " + ($missing | join(",")) end)
    end
end
JQ
)"

# The fixture files a manifest role points at. Argument: $role ("good" or "bad").
JQ_ROLE_SOURCE="$(
  cat <<'JQ'
.[$role].source | select(type == "string")
JQ
)"
JQ_ROLE_COMPANION="$(
  cat <<'JQ'
.[$role].companion // empty | select(type == "string")
JQ
)"

# ---- arguments ----

# A tag that fails this check never reaches an aws or docker command (Requirement 37.12).
valid_tag() {
  local tag="$1"
  [[ "$tag" != *$'\n'* && "$tag" =~ $TAG_PATTERN ]]
}

resolve_tag() {
  local sha shown
  if [[ -n "$TAG_ARG" ]]; then
    TAG="$TAG_ARG"
  else
    sha="${GITHUB_SHA:-}"
    [[ -n "$sha" ]] || fail "no tag was given and GITHUB_SHA is not set"
    TAG="sha-${sha::7}"
  fi
  if ! valid_tag "$TAG"; then
    # %q keeps a newline or a ::command:: in a hostile tag from reaching the workflow log as such.
    printf -v shown '%q' "${TAG:0:40}"
    fail "Invalid image tag ${shown}: expected sha-<7 lowercase hex characters>"
  fi
}

# ---- smoke payloads ----

# Prints the path of a fixture named by the manifest, or fails. The manifest is part of the repo,
# but the paths still go through the same checks as any value that builds a file name.
fixture_file() {
  local rel="$1" path
  if [[ -z "$rel" || "$rel" == /* || "$rel" == *..* || ! "$rel" =~ $PATH_PATTERN ]]; then
    fail "unsafe fixture path in ${SMOKE_MANIFEST}: '${rel}'"
  fi
  path="${FIXTURES_DIR}/${rel}"
  [[ -f "$path" ]] || fail "fixture ${path} named in ${SMOKE_MANIFEST} not found"
  printf '%s' "$path"
}

# build_payload <good|bad> <output file>
build_payload() {
  local role="$1" out="$2" rel companion_rel source_file companion_file="/dev/null"
  rel="$(jq -er --arg role "$role" "$JQ_ROLE_SOURCE" "$SMOKE_MANIFEST")" \
    || fail "${SMOKE_MANIFEST} has no ${role}.source"
  source_file="$(fixture_file "$rel")" || exit 1
  companion_rel="$(jq -er --arg role "$role" "$JQ_ROLE_COMPANION" "$SMOKE_MANIFEST")" \
    || companion_rel=""
  if [[ -n "$companion_rel" ]]; then
    companion_file="$(fixture_file "$companion_rel")" || exit 1
  fi
  jq -cn --rawfile source "$source_file" --slurpfile companion "$companion_file" \
    --argjson contract_version "$CONTRACT_VERSION" "$JQ_PAYLOAD" >"$out" \
    || fail "could not build the ${role} smoke payload from ${source_file}"
}

prepare_smoke() {
  [[ -f "$SMOKE_MANIFEST" ]] || fail "${SMOKE_MANIFEST} not found"
  [[ -f "$CONTRACT_FILE" ]] || fail "${CONTRACT_FILE} not found"
  CONTRACT_VERSION="$(jq -er '.contract_version | select(type == "number" and . == floor and . >= 1)' "$CONTRACT_FILE")" \
    || fail "${CONTRACT_FILE} has no valid contract_version"
  EXPECTED_BAD="$(jq -ec '.bad.expected_codes
    | select(type == "array" and length > 0
        and all(.[]; type == "string" and length > 0 and (startswith("VERIFIER_") | not)))' "$SMOKE_MANIFEST")" \
    || fail "${SMOKE_MANIFEST} needs bad.expected_codes: a non-empty list of codes without a VERIFIER_ prefix"
  build_payload good "${WORK}/payload-good.json"
  build_payload bad "${WORK}/payload-bad.json"
}

# ---- ECR ----

resolve_registry() {
  local account rc=0
  # stderr goes to a file so a CLI warning cannot end up inside the value.
  account="$(aws sts get-caller-identity --region "$REGION" --query Account --output text 2>"${WORK}/aws.err")" \
    || rc=$?
  if [[ $rc -ne 0 ]]; then
    fail "aws sts get-caller-identity failed: $(head -c 400 "${WORK}/aws.err")"
  fi
  [[ "$account" =~ ^[0-9]{12}$ ]] || fail "aws sts get-caller-identity did not return an account id"
  # Mask before any other line can carry it. GitHub then shows *** wherever it would appear.
  echo "::add-mask::${account}"
  REGISTRY="${account}.dkr.ecr.${REGION}.amazonaws.com"
  IMAGE_REPO="${REGISTRY}/${ECR_REPOSITORY}"
}

# Returns 0 when the tag is in ECR and 1 when it is not. Any other answer (no permission, no
# repository, a network error) stops the run: treating it as "not there" would push over a tag.
ecr_tag_exists() {
  local tag="$1" out rc=0
  out="$(aws ecr describe-images --region "$REGION" --repository-name "$ECR_REPOSITORY" \
    --image-ids "imageTag=${tag}" --query 'imageDetails[0].imageDigest' --output text 2>&1)" || rc=$?
  if [[ $rc -eq 0 ]]; then
    return 0
  fi
  if [[ "$out" == *ImageNotFoundException* ]]; then
    return 1
  fi
  fail "could not look up ${ECR_REPOSITORY}:${tag} in ECR: ${out}"
}

build_and_push() {
  info "logging in to ECR"
  aws ecr get-login-password --region "$REGION" \
    | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null \
    || fail "docker login to ECR failed"
  info "building ${ECR_REPOSITORY}:${TAG} (linux/amd64) and pushing it"
  docker buildx build --platform linux/amd64 --provenance=false --sbom=false --push \
    -t "${IMAGE_REPO}:${TAG}" "$VERIFIER_DIR" \
    || fail "docker buildx build failed for ${ECR_REPOSITORY}:${TAG}"
}

# ---- Lambda ----

# Returns 0 when the function exists and 1 when it does not (Requirement 37.11).
function_exists() {
  local out rc=0
  out="$(aws lambda get-function --region "$REGION" --function-name "$FUNCTION_NAME" \
    --query 'Configuration.FunctionName' --output text 2>&1)" || rc=$?
  if [[ $rc -eq 0 ]]; then
    return 0
  fi
  if [[ "$out" == *ResourceNotFoundException* ]]; then
    return 1
  fi
  fail "could not look up function ${FUNCTION_NAME}: ${out}"
}

# update_code <tag>; returns non-zero (never exits) so the caller can roll back.
update_code() {
  local tag="$1" out rc=0
  out="$(aws lambda update-function-code --region "$REGION" --function-name "$FUNCTION_NAME" \
    --image-uri "${IMAGE_REPO}:${tag}" 2>&1)" || rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "[error] update-function-code to ${tag} failed: $(head -c 400 <<<"$out")" >&2
    return 1
  fi
  out="$(aws lambda wait function-updated --region "$REGION" --function-name "$FUNCTION_NAME" 2>&1)" \
    || rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "[error] the function did not reach function-updated for ${tag}: $(head -c 400 <<<"$out")" >&2
    return 1
  fi
  return 0
}

# invoke_check <good|bad> <payload file>; returns non-zero (never exits) on any failed check.
invoke_check() {
  local kind="$1" payload="$2" response meta rc=0 function_error reason expected="[]"
  response="${WORK}/response-${kind}.json"
  [[ "$kind" == "bad" ]] && expected="$EXPECTED_BAD"
  meta="$(aws lambda invoke --region "$REGION" --function-name "$FUNCTION_NAME" \
    --cli-binary-format raw-in-base64-out --cli-read-timeout 90 \
    --payload "file://${payload}" "$response" 2>"${WORK}/invoke.err")" || rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "[error] invoking the ${kind} fixture failed: $(head -c 400 "${WORK}/invoke.err")" >&2
    return 1
  fi
  function_error="$(jq -r '.FunctionError // empty' <<<"$meta" 2>/dev/null)" || {
    echo "[error] invoking the ${kind} fixture gave an answer that is not JSON" >&2
    return 1
  }
  if [[ -n "$function_error" ]]; then
    echo "[error] the ${kind} fixture invocation returned FunctionError ${function_error}: $(jq -r '.errorType // empty' "$response" 2>/dev/null | head -c 200)" >&2
    return 1
  fi
  reason="$(jq -r --arg kind "$kind" --argjson expected "$expected" "$JQ_VERDICT" "$response" 2>/dev/null)" || {
    echo "[error] the ${kind} fixture response is not JSON" >&2
    return 1
  }
  if [[ -n "$reason" ]]; then
    echo "[error] the ${kind} fixture check failed: ${reason}" >&2
    return 1
  fi
  echo "[ok] the ${kind} fixture gave the expected result"
  return 0
}

# The part of a release that rolls back when it fails (Requirement 37.6). Every command is checked
# by hand: this runs as an `if` condition, where `set -e` does not apply.
update_and_check() {
  info "updating ${FUNCTION_NAME} to ${ECR_REPOSITORY}:${TAG}"
  update_code "$TAG" || return 1
  invoke_check good "${WORK}/payload-good.json" || return 1
  invoke_check bad "${WORK}/payload-bad.json" || return 1
  return 0
}

# rollback <previous tag>; always returns, the caller fails the job afterwards (Requirement 37.7).
rollback() {
  local previous="$1"
  if [[ -z "$previous" ]]; then
    warn "no previous tag in ${PARAM_NAME}; ${FUNCTION_NAME} stays on ${TAG}"
    return 1
  fi
  warn "rolling ${FUNCTION_NAME} back to ${previous}"
  if update_code "$previous"; then
    echo "[ok] ${FUNCTION_NAME} is back on ${previous}"
    return 0
  fi
  echo "[error] the rollback to ${previous} failed too; check ${FUNCTION_NAME} by hand" >&2
  return 1
}

# ---- SSM ----

# Prints the tag that is recorded now, or nothing when the parameter does not exist yet.
get_previous_tag() {
  local out err rc=0
  out="$(aws ssm get-parameter --region "$REGION" --name "$PARAM_NAME" \
    --query 'Parameter.Value' --output text 2>"${WORK}/aws.err")" || rc=$?
  if [[ $rc -eq 0 ]]; then
    if [[ "$out" != "None" ]]; then
      printf '%s' "$out"
    fi
    return 0
  fi
  err="$(head -c 400 "${WORK}/aws.err")"
  if [[ "$err" == *ParameterNotFound* ]]; then
    return 0
  fi
  fail "failed to read ${PARAM_NAME}: ${err}"
}

# write_image_tag <tag> <true when the parameter is new>
write_image_tag() {
  local tag="$1" is_new="$2"
  aws ssm put-parameter --region "$REGION" --name "$PARAM_NAME" \
    --type String --value "$tag" --overwrite >/dev/null \
    || fail "could not write ${PARAM_NAME}"
  if [[ "$is_new" == "true" ]]; then
    aws ssm add-tags-to-resource --region "$REGION" --resource-type Parameter \
      --resource-id "$PARAM_NAME" --tags \
      "Key=Project,Value=lore" \
      "Key=Environment,Value=${ENVIRONMENT}" \
      "Key=Component,Value=animation" \
      "Key=ManagedBy,Value=github-actions" \
      "Key=Repo,Value=${REPO_TAG}" >/dev/null \
      || fail "could not tag ${PARAM_NAME}"
  fi
}

# ---- main ----

main() {
  local root previous is_new="false" rollback_mode="false"

  if [[ "$MODE" != "build-and-release" || $# -gt 2 ]]; then
    usage
  fi
  [[ -n "$TAG_ARG" ]] && rollback_mode="true"
  resolve_tag

  for tool in aws docker jq; do
    command -v "$tool" >/dev/null 2>&1 || fail "required tool not found: ${tool}"
  done
  root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
  cd -- "$root" || fail "cannot enter the repository root ${root}"

  WORK="$(mktemp -d)"
  trap cleanup EXIT
  prepare_smoke
  resolve_registry

  if [[ "$rollback_mode" == "true" ]]; then
    ecr_tag_exists "$TAG" || fail "rollback tag ${TAG} is not in ECR repository ${ECR_REPOSITORY}"
    info "rollback tag ${TAG} is in ECR; nothing to build"
  elif ecr_tag_exists "$TAG"; then
    info "${ECR_REPOSITORY}:${TAG} is already in ECR; skipping the build and push"
  else
    build_and_push
  fi

  if ! function_exists; then
    # The first release: the infra PR that creates the function reads this tag (Requirement 36.3).
    warn "function ${FUNCTION_NAME} does not exist yet; skipping update and checks"
    previous="$(get_previous_tag)"
    [[ -z "$previous" ]] && is_new="true"
    write_image_tag "$TAG" "$is_new"
    echo "[ok] recorded ${TAG} in ${PARAM_NAME}; no function to update yet"
    return 0
  fi

  previous="$(get_previous_tag)"
  [[ -z "$previous" ]] && is_new="true"
  info "released tag before this run: ${previous:-none}"

  if ! update_and_check; then
    rollback "$previous" || true
    fail "release of ${TAG} failed its checks; ${PARAM_NAME} was not changed"
  fi

  write_image_tag "$TAG" "$is_new"
  echo "[ok] ${FUNCTION_NAME} runs ${TAG}; ${PARAM_NAME} updated"
}

main "$@"
