#!/bin/bash
set -euo pipefail

COMPONENT="${1:-}"
APP_DIR="${APP_DIR:-/opt/lore}"

if [[ "$COMPONENT" != "web" && "$COMPONENT" != "api" ]]; then
  echo "Usage: $0 <web|api>" >&2
  exit 2
fi

cd "$APP_DIR"

set +e
"${APP_DIR}/render-env.sh" "$COMPONENT"
render_rc=$?
set -e

if [[ $render_rc -eq 10 ]]; then
  echo "[info] belum ada rilis untuk ${COMPONENT}; melewati docker compose up."
  exit 0
elif [[ $render_rc -ne 0 ]]; then
  exit "$render_rc"
fi

docker compose pull

if docker compose config --services | grep -qx "migrate"; then
  docker compose run --rm migrate
fi

docker compose up -d --remove-orphans --wait --wait-timeout 90

if [[ "$COMPONENT" == "api" ]]; then
  curl -fsS --retry 15 --retry-delay 2 --retry-all-errors http://127.0.0.1:8000/health >/dev/null
  if grep -q '^PGHOST=' "${APP_DIR}/.env"; then
    curl -fsS --retry 15 --retry-delay 2 --retry-all-errors http://127.0.0.1:8000/health/db >/dev/null
  fi
fi

docker image prune -f >/dev/null
