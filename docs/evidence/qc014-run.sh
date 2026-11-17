#!/usr/bin/env bash
# QC-014: run the Electron three-party acceptance end to end, under the e2e lock.
#   docs/evidence/qc014-run.sh [output-dir]
# Starts mac-server (7420) on a throwaway CREATORHUB_HOME, seeds it, starts the Electron
# dev window (Vite 5180, CDP 9333), runs qc014-verify.mjs, then stops everything, frees the
# ports, deletes the temp dirs and releases the lock (only if it is still ours).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$ROOT/docs/evidence}"
LOCK=/private/tmp/claude-501/qc-e2e.lock
OWNER="qc-bugfix QC-014 $(date +%F)"
PNPM=(corepack pnpm)

if ! mkdir "$LOCK" 2>/dev/null; then
  echo "e2e lock held by: $(cat "$LOCK/owner" 2>/dev/null || echo unknown)" >&2
  exit 3
fi
echo "$OWNER" >"$LOCK/owner"

HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/qc014-home.XXXXXX")"
MOUNT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/qc014-mount.XXXXXX")"
PIDS=()

cleanup() {
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill -KILL -- "-$pid" 2>/dev/null || true
  done
  rm -rf "$HOME_DIR" "$MOUNT_DIR"
  if [ "$(cat "$LOCK/owner" 2>/dev/null)" = "$OWNER" ]; then
    rm -f "$LOCK/owner" && rmdir "$LOCK"
  fi
  for port in 7420 5180 9333; do
    if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then echo "port $port still in use" >&2; fi
  done
}
trap cleanup EXIT

for port in 7420 5180 9333; do
  if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is busy; not starting" >&2
    exit 4
  fi
done

export CREATORHUB_HOME="$HOME_DIR"
export QC014_MOUNT_DIR="$MOUNT_DIR"
cd "$ROOT"

set -m # own process group per background job so the whole tree can be stopped
(cd services/mac-server && exec "${PNPM[@]}" exec node --import tsx src/main.ts) >"$HOME_DIR/server.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 100); do
  curl -s -m 1 -o /dev/null http://127.0.0.1:7420/health && break
  sleep 0.2
done
node docs/evidence/qc014-seed.mjs || exit 1

(cd apps/mac && exec node scripts/dev.mjs --remote-debugging-port=9333) >"$HOME_DIR/electron.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 150); do
  curl -s -m 1 http://127.0.0.1:9333/json/list 2>/dev/null | grep -q '"type": "page"' && break
  sleep 0.2
done
sleep 2

node docs/evidence/qc014-verify.mjs "$OUT"
status=$?
echo "verify exit status: $status"
exit $status
