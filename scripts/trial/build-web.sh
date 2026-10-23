#!/usr/bin/env bash
#
# Build the Flutter web bundle for the Trial deployment WITH the backend address
# baked in, and FAIL if the built bundle does not actually contain it.
#
# Why this exists: API_BASE_URL is read at COMPILE time (BackendConfig,
# String.fromEnvironment). If the define is missing, the app silently falls back
# to the in-memory demo (mock data) — the exact regression that put a demo build
# on https://trial.adlink4.com. `app/config/trial.env` is git-ignored, so a fresh
# checkout will NOT have it; this script refuses to build without it rather than
# producing a demo bundle, and then proves the address is present in the output.
#
# Usage:  scripts/trial/build-web.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd "$here/../../app" && pwd)"
env_file="$app_dir/config/trial.env"

if [[ ! -f "$env_file" ]]; then
  echo "ERROR: $env_file not found (it is git-ignored). Create it from" >&2
  echo "       config/trial.env.example with the real API_BASE_URL first." >&2
  exit 1
fi

# API_BASE_URL is an address, not a secret. Read it only to derive the host for
# the post-build check; never echo the whole env file.
api_base_url="$(grep -E '^API_BASE_URL=' "$env_file" | head -n1 | cut -d= -f2-)"
if [[ -z "${api_base_url//[[:space:]]/}" ]]; then
  echo "ERROR: API_BASE_URL is empty in trial.env — a build now would be a demo (mock) build." >&2
  exit 1
fi
no_scheme="${api_base_url#*://}"
host="${no_scheme%%/*}"
echo "==> Building Trial web for backend host: $host"

cd "$app_dir"
flutter build web --release --no-web-resources-cdn --dart-define-from-file=config/trial.env

bundle="$app_dir/build/web/main.dart.js"
if [[ ! -f "$bundle" ]]; then
  echo "ERROR: build produced no $bundle" >&2
  exit 1
fi
if ! grep -qaF "$host" "$bundle"; then
  echo "ERROR: built bundle does NOT contain backend host '$host'." >&2
  echo "       This is a DEMO build (API_BASE_URL was not applied). Refusing." >&2
  exit 1
fi
echo "==> OK: built bundle contains backend host '$host' (backend mode confirmed)."
