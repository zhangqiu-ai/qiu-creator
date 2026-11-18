#!/usr/bin/env bash
# QC-026: run the Electron M3 acceptance end to end, under the e2e lock.
#   docs/evidence/qc026-run.sh [output-dir]
# Starts the fake AI providers (control 7433), the real mac-server (7420, request log on, restarted
# automatically if it is killed), seeds data, starts Electron (Vite 5180, CDP 9333), runs
# qc026-verify.mjs, then stops everything, frees the ports, deletes the temp dirs and releases
# the lock (only if it is still ours). Only local fakes: no request leaves the machine.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$ROOT/docs/evidence}"
LOCK=/private/tmp/claude-501/qc-e2e.lock
OWNER="qc-bugfix QC-026 $(date +%F)"

if ! mkdir "$LOCK" 2>/dev/null; then
  echo "e2e lock held by: $(cat "$LOCK/owner" 2>/dev/null || echo unknown)" >&2
  exit 3
fi
echo "$OWNER" >"$LOCK/owner"

HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/qc026-home.XXXXXX")"
KEYS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/qc026-keys.XXXXXX")"
PIDS=()

cleanup() {
  touch "$HOME_DIR/stop-server" 2>/dev/null
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && { kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true; }
  done
  sleep 1
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill -KILL -- "-$pid" 2>/dev/null || true
  done
  rm -rf "$HOME_DIR" "$KEYS_DIR"
  if [ "$(cat "$LOCK/owner" 2>/dev/null)" = "$OWNER" ]; then
    rm -f "$LOCK/owner" && rmdir "$LOCK"
  fi
  for port in 7420 7433 5180 9333; do
    if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then echo "port $port still in use" >&2; fi
  done
}
trap cleanup EXIT

for port in 7420 7433 5180 9333; do
  if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is busy; not starting" >&2
    exit 4
  fi
done

export CREATORHUB_HOME="$HOME_DIR"
export QC026_KEYS_DIR="$KEYS_DIR"
export QC026_SERVER_LOG="$HOME_DIR/server.log"
cd "$ROOT"

set -m # own process group per background job so each tree can be stopped
(cd services/mac-server && exec node --import tsx ../../docs/evidence/qc026-fakes.mjs) >"$HOME_DIR/fakes.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 100); do
  [ -f "$HOME_DIR/fakes.json" ] && curl -s -m 1 -o /dev/null http://127.0.0.1:7433/state && break
  sleep 0.2
done

# The server is restarted by this loop whenever it dies (the driver kills it on purpose once).
(
  while [ ! -f "$HOME_DIR/stop-server" ]; do
    (cd services/mac-server && node --import tsx ../../docs/evidence/qc026-server.mjs) >>"$QC026_SERVER_LOG" 2>&1
    sleep 0.3
  done
) &
PIDS+=($!)
for _ in $(seq 1 150); do
  curl -s -m 1 -o /dev/null http://127.0.0.1:7420/health && break
  sleep 0.2
done
node docs/evidence/qc026-seed.mjs || exit 1

(cd apps/mac && exec node scripts/dev.mjs --remote-debugging-port=9333) >"$HOME_DIR/electron.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 150); do
  curl -s -m 1 http://127.0.0.1:9333/json/list 2>/dev/null | grep -q '"type": "page"' && break
  sleep 0.2
done
sleep 2

node docs/evidence/qc026-verify.mjs "$OUT"
status=$?
echo "verify exit status: $status"
exit $status
