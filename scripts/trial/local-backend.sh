#!/usr/bin/env bash
#
# local-backend.sh — bring up an ISOLATED local backend for the Flutter app to
# connect to, so the app can be exercised against the real API (not the
# demo/mock repositories) on the way to a usable trial release.
#
# This is a DEVELOPER / TRIAL harness. It is not production, uses only throwaway
# secrets it generates itself, and never reads infra/env/*.env (staging /
# production credentials). Physical-device testing is out of scope here — this
# is the web app against a real backend on localhost.
#
# Usage:
#   scripts/trial/local-backend.sh up       # start Postgres, migrate, bootstrap owner
#   scripts/trial/local-backend.sh serve     # run the API in the foreground (Ctrl-C to stop)
#   scripts/trial/local-backend.sh smoke      # run the HTTP integration smoke (needs `serve` running)
#   scripts/trial/local-backend.sh down       # stop & remove the throwaway Postgres
#
# Then point the Flutter web app at it:
#   cd app && flutter run -d chrome \
#     --dart-define=API_BASE_URL=http://localhost:3100
#
# Config via environment (all optional):
#   PG_PORT        host port for the throwaway Postgres   (default 5433)
#   API_PORT       port the API listens on                (default 3100)
#   WEB_ORIGIN     CORS origin for the Flutter web build  (default http://localhost:8080)
#   OWNER_EMAIL / OWNER_NAME / OWNER_PASSWORD             (dev defaults below)
#
set -euo pipefail

PG_CONTAINER="trial-pg"
PG_PORT="${PG_PORT:-5433}"
API_PORT="${API_PORT:-3100}"
WEB_ORIGIN="${WEB_ORIGIN:-http://localhost:8080}"
OWNER_EMAIL="${OWNER_EMAIL:-owner@institution.test}"
OWNER_NAME="${OWNER_NAME:-Trial Owner}"
OWNER_PASSWORD="${OWNER_PASSWORD:-Owner-Trial-Pass-9x7q}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
DB_URL="postgresql://institution:devpw@127.0.0.1:${PG_PORT}/institution"
SECRETS_FILE="${TMPDIR:-/tmp}/trial-backend-secrets.env"

gen() { node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"; }

ensure_secrets() {
  # Throwaway, generated once per machine session; never committed, never prod.
  if [ ! -f "$SECRETS_FILE" ]; then
    {
      echo "export JWT_SECRET=dev-only-jwt-$(gen)"
      echo "export STORAGE_SIGNING_SECRET=dev-only-storage-$(gen)"
    } > "$SECRETS_FILE"
  fi
  # shellcheck disable=SC1090
  . "$SECRETS_FILE"
}

up() {
  if ! docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
    if docker ps -a --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
      docker start "$PG_CONTAINER" >/dev/null
    else
      echo "Starting throwaway Postgres on 127.0.0.1:${PG_PORT} ..."
      docker run -d --name "$PG_CONTAINER" \
        -e POSTGRES_USER=institution -e POSTGRES_PASSWORD=devpw -e POSTGRES_DB=institution \
        -p "127.0.0.1:${PG_PORT}:5432" postgres:16 >/dev/null
    fi
  fi
  echo -n "Waiting for Postgres"
  for _ in $(seq 1 30); do
    if docker exec "$PG_CONTAINER" pg_isready -U institution -d institution -h 127.0.0.1 >/dev/null 2>&1; then
      echo " — ready."; break
    fi
    echo -n "."; command sleep 1 2>/dev/null || true
  done

  echo "Applying migrations ..."
  (cd "$BACKEND_DIR" && DATABASE_URL="$DB_URL" npm run --silent db:migrate >/dev/null)

  echo "Bootstrapping the owner account (ignored if one already exists) ..."
  (cd "$BACKEND_DIR" && printf '%s\n' "$OWNER_PASSWORD" | \
    DATABASE_URL="$DB_URL" node dist/cli/bootstrap-owner.js \
      --email "$OWNER_EMAIL" --name "$OWNER_NAME" 2>&1 | tail -1) || true

  cat <<EOF

Local backend is provisioned.
  DATABASE_URL : $DB_URL   (throwaway container "$PG_CONTAINER")
  owner        : $OWNER_EMAIL  (password: the OWNER_PASSWORD you set / the dev default)

Next:
  scripts/trial/local-backend.sh serve           # run the API on :$API_PORT
  cd app && flutter run -d chrome --dart-define=API_BASE_URL=http://localhost:$API_PORT
EOF
}

serve() {
  ensure_secrets
  echo "Starting API on http://localhost:${API_PORT} (CORS: ${WEB_ORIGIN}) — Ctrl-C to stop"
  cd "$BACKEND_DIR"
  DATABASE_URL="$DB_URL" NODE_ENV=development PORT="$API_PORT" LOG_LEVEL=warn \
    CORS_ORIGINS="$WEB_ORIGIN" \
    JWT_SECRET="$JWT_SECRET" STORAGE_SIGNING_SECRET="$STORAGE_SIGNING_SECRET" \
    exec node dist/main.js
}

smoke() {
  # The canonical journey test is the Jest integration spec
  # (backend/test/integration/academic-journey-postgres.spec.ts) — the same
  # test CI runs. Here it runs against the throwaway Postgres started by `up`
  # (it creates and drops its own scratch databases, leaving `serve`'s data
  # untouched). `serve` need not be running; the spec boots its own app.
  if ! docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
    echo "Postgres is not running — run '$0 up' first." >&2; exit 1
  fi
  cd "$BACKEND_DIR"
  TEST_DATABASE_URL="$DB_URL" exec npx jest \
    test/integration/academic-journey-postgres.spec.ts --runInBand
}

down() {
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  rm -f "$SECRETS_FILE" || true
  echo "Removed throwaway Postgres and local secrets."
}

case "${1:-}" in
  up) up ;;
  serve) serve ;;
  smoke) smoke ;;
  down) down ;;
  *) echo "usage: $0 {up|serve|smoke|down}" >&2; exit 2 ;;
esac
