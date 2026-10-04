#!/bin/sh
# P8.4 — the generator's SSH forced command (design §3). Root installs it as
# /opt/p84/bin/p84-dispatch (not writable by user p84); p84's authorized_keys
# entry for the SUT key is
#   restrict,from="213.136.65.135",command="/opt/p84/bin/p84-dispatch"
# so sshd runs this instead of whatever the client asked for, and the request
# arrives in SSH_ORIGINAL_COMMAND. Exactly four requests are allowed:
#   agent <runId>      the fleet agent, NDJSON control channel on stdio
#   install <sha256>   git bundle on stdin -> new version dir, npm ci, switch `current`
#   fetch <runId>      tar of that run's directory to stdout
#   stop <runId>       the agent's emergency stop: signals only that run's recorded PIDs
# runId is 16 lowercase hex digits, sha256 is 64. Anything else -> stderr, exit 64.
# The request is never evaluated by a shell: it is split once and every part is
# checked against a fixed allowlist before use.
#
# Test overrides: P84_ROOT, P84_RUNS, P84_NODE; P84_DRY_RUN=1 prints the command
# line(s) that would run to stdout instead of running them (install still reads
# and verifies the bundle first).
set -eu

P84_ROOT=${P84_ROOT:-/opt/p84}
P84_RUNS=${P84_RUNS:-/var/lib/p84/runs}
P84_NODE=${P84_NODE:-node}
DRY_RUN=${P84_DRY_RUN:-0}

# fail <exit code> <message>
fail() {
  printf 'p84-dispatch: %s\n' "$2" >&2
  exit "$1"
}

# require_hex <value> <length>: exactly <length> lowercase hex digits, else refuse.
require_hex() {
  [ "${#1}" -eq "$2" ] || refuse
  case $1 in *[!0123456789abcdef]*) refuse ;; esac
}

refuse() {
  fail 64 'refused; allowed: agent <runId> | install <sha256> | fetch <runId> | stop <runId>'
}

# step <command> [args...]: run one step with its output on stderr (stdout carries
# only the result), or under P84_DRY_RUN=1 print it to stdout instead.
step() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '%s\n' "$*"
  else
    "$@" >&2
  fi
}

# run <command> [args...]: replace this shell with the command (it owns stdio),
# or under P84_DRY_RUN=1 print it to stdout and stop.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '%s\n' "$*"
    exit 0
  fi
  exec "$@"
}

# agent-main.ts from the installed checkout, with the harness's ts-node loader.
run_agent() {
  backend=$P84_ROOT/current/backend
  step cd "$backend"
  run "$P84_NODE" -r ts-node/register/transpile-only "$backend/test/load/fleet/agent-main.ts" \
    "$@" --runs-dir "$P84_RUNS"
}

# install <sha256>: all-or-nothing. The bundle must hash to <sha256>; the version
# directory is created only for this install and removed again if any later step
# fails, so a failed install can be retried. Prints the installed commit hash.
install_version() {
  version=$P84_ROOT/versions/$1
  link=$P84_ROOT/.current-$1
  [ ! -e "$version" ] || fail 66 "version $1 is already installed"
  bundle=$(mktemp)
  trap 'rm -f "$bundle"' EXIT
  cat >"$bundle"
  sum=$(sha256sum <"$bundle")
  [ "${sum%% *}" = "$1" ] || fail 65 "bundle does not match sha256 $1"
  step mkdir -p "$P84_ROOT/versions"
  step mkdir "$version"
  [ "$DRY_RUN" = 1 ] || trap 'rm -f "$bundle"; rm -rf "$version"' EXIT
  step git clone --quiet "$bundle" "$version/repo"
  step cd "$version/repo/backend"
  step npm ci --include=dev --no-audit --no-fund
  step ln -sfn "versions/$1/repo" "$link"
  step mv -T "$link" "$P84_ROOT/current"
  trap 'rm -f "$bundle"' EXIT
  [ "$DRY_RUN" = 1 ] || git -C "$version/repo" rev-parse HEAD
}

# Split once at the first space; a request without one leaves verb = arg, which
# no allowlist entry accepts. Extra words, whitespace or metacharacters end up in
# arg and fail require_hex.
request=${SSH_ORIGINAL_COMMAND-}
verb=${request%% *}
arg=${request#* }

case $verb in
  agent)
    require_hex "$arg" 16
    run_agent --run "$arg"
    ;;
  stop)
    require_hex "$arg" 16
    run_agent --stop "$arg"
    ;;
  fetch)
    require_hex "$arg" 16
    run tar -C "$P84_RUNS" -cf - "$arg"
    ;;
  install)
    require_hex "$arg" 64
    install_version "$arg"
    ;;
  *) refuse ;;
esac
