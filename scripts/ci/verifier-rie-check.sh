#!/usr/bin/env bash
# Parity gate for the animation verifier Lambda image (design 8.4; Requirements 37.1, 38.8, 11.4).
#
# Why: Vitest runs the verifier from source on the CI host, but production runs the built container
# image on Lambda (Node 22, 1536 MB, read-only root, /tmp only). This script starts that image
# under the Lambda Runtime Interface Emulator (RIE) that ships in the AWS base image, sends every
# fixtures/good/*.ts and fixtures/bad/*.ts through it, and fails when the image disagrees with the
# Vitest corpus run (animation-verifier/.corpus-results.json, written by tests/corpus.test.ts).
#
# Usage: scripts/ci/verifier-rie-check.sh <image> <pkgdir>
#   <image>   local image tag, built without push, for example
#             docker build --platform linux/amd64 --provenance=false --sbom=false -t lore-verifier:ci animation-verifier
#   <pkgdir>  the verifier package directory (animation-verifier). It must contain
#             fixtures/good, fixtures/bad (+ expected.json), contract/animation-contract.json and
#             .corpus-results.json. Run `npx vitest run` there first so the last file is current.
# Env:    RIE_PORT  host port on 127.0.0.1 mapped to the emulator (default 9000).
# Exit:   0 every fixture matches, 1 a mismatch or an environment failure, 2 bad usage.
#
# Request payload, same rule as tests/support/corpus.ts (the Vitest corpus loader):
#   source             the fixture bytes through `jq --rawfile` (a UTF-8 BOM is kept; the
#                      ENCODING_INVALID fixture needs it)
#   kind, required_tokens, forbidden_tokens
#                      from the companion <name>.json when it exists, else lesson, [] and []
#                      (good/ companions are mandatory, bad/ ones are optional)
#   contract_version   from contract/animation-contract.json
#
# What is compared, per fixture:
#   1. the response is a Verifier_Result (`ok` boolean, `diagnostics` array), not a Lambda error
#      object, and carries no VERIFIER_* code (that would be the verifier failing, not a finding);
#   2. `ok` equals the Vitest result, and good/ gives true and bad/ gives false;
#   3. the sorted, unique list of Diagnostic codes equals the Vitest list (Requirement 37.1);
#   4. for bad/, every code that expected.json lists is present (a SUBSET check, because a fixture
#      may report more codes than the minimum). This also catches a stale .corpus-results.json.
# One tolerance only: bad/render-resource-limit.ts exhausts the render Worker's heap in about
# 1.0 to 1.4 s, while the watchdog fires after 2000 ms without progress. In a 1536 MB container
# either can win, so RENDER_FRAME_TIMEOUT and RENDER_RESOURCE_LIMIT count as the same code for that
# fixture and nowhere else (same rule as EQUIVALENT_CODES in tests/corpus.test.ts).
#
# The container is always removed on exit, including on Ctrl-C. On failure its last log lines are
# printed (the verifier logs one JSON line per invocation: request_id, ok, checks, by_code).
set -euo pipefail

IMAGE="${1:-}"
PKG="${2:-}"
PORT="${RIE_PORT:-9000}"
CONTAINER="lore-verifier-rie-$$"
URL="http://127.0.0.1:${PORT}/2015-03-31/functions/function/invocations"
RESULTS="${PKG}/.corpus-results.json"
CONTRACT_FILE="${PKG}/contract/animation-contract.json"
EXPECTED_BAD="${PKG}/fixtures/bad/expected.json"
READY_ATTEMPTS=60

STARTED="false"
WORK=""
FAILURES=0
TOTAL=0
TOLERATED=0

fail() {
  echo "[fail] $*" >&2
  exit 1
}

usage() {
  echo "Usage: $0 <image> <pkgdir>" >&2
  echo "  <image>   local verifier image tag (for example lore-verifier:ci)" >&2
  echo "  <pkgdir>  verifier package directory (for example animation-verifier)" >&2
  exit 2
}

# A fixture that differs from the baseline: report it and keep going, so one run lists them all.
mismatch() {
  echo "[fail] $*" >&2
  FAILURES=$((FAILURES + 1))
}

cleanup() {
  local rc=$?
  trap - EXIT
  if [[ "$STARTED" == "true" ]]; then
    if [[ $rc -ne 0 ]] && docker container inspect "$CONTAINER" >/dev/null 2>&1; then
      echo "[info] last log lines of ${CONTAINER}:" >&2
      docker logs --tail 40 "$CONTAINER" >&2 2>&1 || true
    fi
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
  if [[ -n "$WORK" ]]; then
    rm -rf -- "$WORK"
  fi
  exit "$rc"
}

# ---- arguments ----

if [[ $# -ne 2 || -z "$IMAGE" || "$IMAGE" == -* || -z "$PKG" ]]; then
  usage
fi
if [[ ! "$PORT" =~ ^[1-9][0-9]{0,4}$ ]] || ((PORT > 65535)); then
  echo "[fail] RIE_PORT must be a TCP port number, got '${PORT}'" >&2
  exit 2
fi

# ---- inputs (everything is checked before a container starts) ----

for tool in docker jq curl; do
  command -v "$tool" >/dev/null 2>&1 || fail "required tool not found: ${tool}"
done

[[ -d "${PKG}/fixtures/good" && -d "${PKG}/fixtures/bad" ]] \
  || fail "${PKG}/fixtures/good and ${PKG}/fixtures/bad must exist"
[[ -f "$CONTRACT_FILE" ]] || fail "${CONTRACT_FILE} not found"
[[ -f "$EXPECTED_BAD" ]] || fail "${EXPECTED_BAD} not found"
[[ -f "$RESULTS" ]] \
  || fail "${RESULTS} not found; run 'npx vitest run' in ${PKG} first (tests/corpus.test.ts writes it)"
jq -e 'type == "object"' "$RESULTS" >/dev/null 2>&1 || fail "${RESULTS} is not a JSON object"
jq -e 'type == "object"' "$EXPECTED_BAD" >/dev/null 2>&1 || fail "${EXPECTED_BAD} is not a JSON object"

CONTRACT_VERSION="$(jq -er '.contract_version | select(type == "number" and . == floor and . >= 1)' "$CONTRACT_FILE")" \
  || fail "${CONTRACT_FILE} has no valid contract_version"

shopt -s nullglob
# Byte order, so the run order does not depend on the runner's locale (en_US ignores punctuation).
export LC_COLLATE=C
good_files=("${PKG}"/fixtures/good/*.ts)
bad_files=("${PKG}"/fixtures/bad/*.ts)
shopt -u nullglob
((${#good_files[@]} > 0)) || fail "no fixtures in ${PKG}/fixtures/good"
((${#bad_files[@]} > 0)) || fail "no fixtures in ${PKG}/fixtures/bad"

# The fixture set on disk must be the set the Vitest run saw, otherwise the baseline is stale.
want_keys="$(jq -r 'keys[] | select(startswith("good/") or startswith("bad/"))' "$RESULTS" | LC_ALL=C sort)"
have_keys="$(
  for file in "${good_files[@]}"; do printf 'good/%s\n' "${file##*/}"; done
  for file in "${bad_files[@]}"; do printf 'bad/%s\n' "${file##*/}"; done
)"
have_keys="$(LC_ALL=C sort <<<"$have_keys")"
if [[ "$want_keys" != "$have_keys" ]]; then
  key_diff="$(diff <(printf '%s\n' "$want_keys") <(printf '%s\n' "$have_keys") || true)"
  fail "fixtures differ from ${RESULTS} (< baseline, > disk); re-run 'npx vitest run' in ${PKG}:
${key_diff}"
fi

# ---- jq programs ----

# Verdict for one response. Input: the response. Arguments: $key (good/x.ts), $name (x.ts),
# $baseline (.corpus-results.json), $expected (bad/expected.json). Output: one tab-separated line
# verdict, image ok, image codes, baseline ok, baseline codes, missing expected codes ("-" = none).
JQ_COMPARE="$(
  cat <<'JQ'
def canon($k):
  if $k == "bad/render-resource-limit.ts"
  then map(if . == "RENDER_FRAME_TIMEOUT" then "RENDER_RESOURCE_LIMIT" else . end) | unique
  else . end;
def csv: if length == 0 then "-" else join(",") end;
([.diagnostics[].code] | unique) as $got
| $baseline[0][$key] as $want
| (if ($key | startswith("bad/")) then ($expected[0][$name] // []) else [] end) as $minimum
| (($minimum | canon($key)) - ($got | canon($key))) as $missing
| (if ($got | any(startswith("VERIFIER_"))) then "VERIFIER"
   elif $want == null then "NOBASELINE"
   elif $want.ok != .ok then "OK"
   elif (($key | startswith("bad/")) == .ok) then "FOLDER"
   elif ($want.codes != $got) and (($want.codes | canon($key)) != ($got | canon($key))) then "CODES"
   elif ($missing | length) > 0 then "MISSING"
   elif $want.codes != $got then "TOLERATED"
   else "SAME" end) as $verdict
| [ $verdict,
    (.ok | tostring),
    ($got | csv),
    (if $want == null then "-" else ($want.ok | tostring) end),
    (if $want == null then "-" else ($want.codes | csv) end),
    ($missing | csv) ]
| @tsv
JQ
)"

# Request payload. Arguments: $source (raw file), $companion (slurped; [] when absent),
# $contract_version.
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

# ---- container ----

start_container() {
  docker image inspect "$IMAGE" >/dev/null 2>&1 \
    || fail "image '${IMAGE}' not found locally; build it first (docker build --platform linux/amd64 --provenance=false --sbom=false -t ${IMAGE} ${PKG})"
  echo "[info] starting ${IMAGE} under the Lambda Runtime Interface Emulator on 127.0.0.1:${PORT}"
  # Set before `docker run`, so a container that was created but failed to start is still removed.
  STARTED="true"
  # --memory/--read-only/--tmpfs mirror the Lambda limits (Requirement 37.1). AWS_LAMBDA_FUNCTION_*
  # are the emulator's own settings: a 60 s function timeout and the 1536 MB memory size that the
  # Node runtime reads, both as configured for the real function (Requirement 11.4).
  docker run -d --name "$CONTAINER" \
    --memory 1536m --read-only --tmpfs /tmp \
    -e AWS_LAMBDA_FUNCTION_TIMEOUT=60 -e AWS_LAMBDA_FUNCTION_MEMORY_SIZE=1536 \
    -p "127.0.0.1:${PORT}:8080" \
    "$IMAGE" >/dev/null \
    || fail "docker run failed for '${IMAGE}' (is port ${PORT} free?)"
}

# The emulator accepts connections before the function has finished initialising, and the first
# invocation waits for it. An empty event gets a Verifier_Result (VERIFIER_BAD_INPUT) back from the
# handler without starting a render Worker, so the probe does not warm the render path: a slow first
# render stays visible instead of being hidden.
wait_ready() {
  local attempt running rc probe
  probe="${WORK}/probe.json"
  echo "[info] waiting for the emulator (up to ${READY_ATTEMPTS} probes)"
  for ((attempt = 1; attempt <= READY_ATTEMPTS; attempt++)); do
    running="$(docker container inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
    [[ "$running" == "true" ]] || fail "container ${CONTAINER} is not running (it exited during start-up)"
    rc=0
    curl --silent --max-time 20 -XPOST "$URL" --data-binary '{}' --output "$probe" || rc=$?
    if [[ $rc -eq 0 ]] && jq -e '(.ok | type) == "boolean"' "$probe" >/dev/null 2>&1; then
      echo "[ok] emulator answered on probe ${attempt}"
      return 0
    fi
    sleep 1
  done
  fail "the emulator did not answer a Verifier_Result within ${READY_ATTEMPTS} probes"
}

# ---- one fixture ----

# Sends one fixture and records a mismatch (never exits) when the image disagrees with the baseline.
check_fixture() {
  local key="$1" source_file="$2"
  local name="${key#*/}"
  local companion="${source_file%.ts}.json"
  local payload="${WORK}/payload.json" response="${WORK}/response.json"
  local out http total rc=0 line
  local verdict got_ok got_codes want_ok want_codes missing

  TOTAL=$((TOTAL + 1))
  [[ -f "$companion" ]] || companion="/dev/null"
  jq -cn --rawfile source "$source_file" --slurpfile companion "$companion" \
    --argjson contract_version "$CONTRACT_VERSION" "$JQ_PAYLOAD" >"$payload" \
    || fail "could not build the request for ${key}"

  rm -f -- "$response"
  out="$(curl --silent --show-error --max-time 60 -XPOST "$URL" --data-binary "@${payload}" \
    --output "$response" --write-out '%{http_code} %{time_total}')" || rc=$?
  if [[ $rc -ne 0 ]]; then
    mismatch "${key}: curl failed with exit code ${rc} (28 = the 60 s limit passed)"
    return 0
  fi
  read -r http total <<<"$out"
  if [[ "$http" != "200" ]]; then
    mismatch "${key}: the emulator answered HTTP ${http}"
    return 0
  fi
  if ! jq -e '(.ok | type) == "boolean" and (.diagnostics | type) == "array"
      and all(.diagnostics[]; (.code | type) == "string")' "$response" >/dev/null 2>&1; then
    # A Lambda error (crash, out-of-memory kill, timeout) arrives as {"errorType","errorMessage"}.
    mismatch "${key}: the response is not a Verifier_Result: $(head -c 300 "$response" | tr '\r\n' '  ')"
    return 0
  fi

  line="$(jq -r --arg key "$key" --arg name "$name" \
    --slurpfile baseline "$RESULTS" --slurpfile expected "$EXPECTED_BAD" "$JQ_COMPARE" "$response")" \
    || fail "could not compare the response for ${key}"
  IFS=$'\t' read -r verdict got_ok got_codes want_ok want_codes missing <<<"$line"

  case "$verdict" in
    SAME)
      echo "[ok] ${key} ok=${got_ok} codes=${got_codes} (${total}s)"
      ;;
    TOLERATED)
      TOLERATED=$((TOLERATED + 1))
      echo "[warn] ${key} ok=${got_ok}: image codes ${got_codes}, corpus run ${want_codes}; RENDER_FRAME_TIMEOUT and RENDER_RESOURCE_LIMIT are interchangeable for this fixture (${total}s)"
      ;;
    VERIFIER)
      mismatch "${key}: the image returned a VERIFIER_* code (${got_codes}); the verifier failed instead of judging the file"
      ;;
    NOBASELINE)
      mismatch "${key}: no entry in ${RESULTS}"
      ;;
    FOLDER)
      mismatch "${key}: ok=${got_ok}, but good/ fixtures must give ok=true and bad/ fixtures ok=false (image codes: ${got_codes})"
      ;;
    OK)
      mismatch "${key}: ok differs (corpus run ${want_ok}, image ${got_ok}; image codes: ${got_codes})"
      ;;
    CODES)
      mismatch "${key}: codes differ (corpus run: ${want_codes}; image: ${got_codes})"
      ;;
    MISSING)
      mismatch "${key}: codes listed in bad/expected.json are missing from the image result: ${missing} (image: ${got_codes})"
      ;;
    *)
      mismatch "${key}: unexpected comparison verdict '${verdict}'"
      ;;
  esac
}

# ---- main ----

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

WORK="$(mktemp -d)"
start_container
wait_ready

for file in "${good_files[@]}"; do
  check_fixture "good/${file##*/}" "$file"
done
for file in "${bad_files[@]}"; do
  check_fixture "bad/${file##*/}" "$file"
done

if [[ $FAILURES -gt 0 ]]; then
  fail "${FAILURES} of ${TOTAL} fixtures differ from ${RESULTS} (see the [fail] lines above)"
fi
echo "[ok] ${TOTAL} fixtures match ${RESULTS} (${#good_files[@]} good, ${#bad_files[@]} bad, ${TOLERATED} tolerated)"
