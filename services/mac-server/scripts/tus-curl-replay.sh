#!/usr/bin/env bash
# QC-008: replay the QC-005 manual curl sequence (docs/evidence/qc005-curl-run.md §6)
# N times against a throwaway CREATORHUB_HOME: 40 MiB tus upload, first PATCH cut by
# `curl --limit-rate 8M --max-time 2`, HEAD, then resume with `tail -c | curl --data-binary @-`.
# Local only. Usage: scripts/tus-curl-replay.sh [iterations] [resume-delay-seconds]
set -euo pipefail
N="${1:-30}"
DELAY="${2:-0}"
cd "$(dirname "$0")/.."

HOME_DIR="$(mktemp -d -t qc008-curl-home)"
FILES="$(mktemp -d -t qc008-curl-files)"
LOG="$FILES/server.log"
TOKEN="$(openssl rand -hex 24)"
PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
BASE="http://127.0.0.1:$PORT"
TUS="$BASE/api/v1/assets/uploads/tus"

CREATORHUB_HOME="$HOME_DIR" CREATORHUB_PORT="$PORT" CREATORHUB_TOKEN="$TOKEN" \
  node --import tsx src/main.ts >"$LOG" 2>&1 &
SERVER=$!
cleanup() {
  kill -TERM "$SERVER" 2>/dev/null || true
  wait "$SERVER" 2>/dev/null || true
  rm -rf "$HOME_DIR"
  if [ "${KEEP_LOG:-0}" = 1 ]; then echo "log kept: $LOG"; else rm -rf "$FILES"; fi
}
trap cleanup EXIT
for _ in $(seq 1 100); do
  curl -s -o /dev/null -m 1 -H "authorization: Bearer $TOKEN" "$BASE/api/v1/assets?limit=1" && break
  sleep 0.1
done

ok=0
fail=0
for i in $(seq 1 "$N"); do
  f="$FILES/big-$i.mp4"
  { printf '\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2'; head -c $((41943040 - 24)) /dev/urandom; } >"$f"
  want="$(shasum -a 256 "$f" | cut -d' ' -f1)"
  loc="$(curl -s -i -X POST "$TUS" -H "authorization: Bearer $TOKEN" -H 'tus-resumable: 1.0.0' \
    -H 'upload-length: 41943040' -H "upload-metadata: filename $(printf 'big.mp4' | base64)" |
    tr -d '\r' | awk -F': ' 'tolower($1)=="location"{print $2}')"
  url="$BASE$loc"
  curl -s -o /dev/null -X PATCH "$url" -H "authorization: Bearer $TOKEN" -H 'tus-resumable: 1.0.0' \
    -H 'content-type: application/offset+octet-stream' -H 'upload-offset: 0' \
    --data-binary @"$f" --limit-rate 8M --max-time 2 || true
  sleep "$DELAY"
  off="$(curl -s -I -m 15 "$url" -H "authorization: Bearer $TOKEN" -H 'tus-resumable: 1.0.0' |
    tr -d '\r' | awk -F': ' 'tolower($1)=="upload-offset"{print $2}')"
  out="$(tail -c +$((off + 1)) "$f" | curl -s -m 60 -X PATCH "$url" -H "authorization: Bearer $TOKEN" \
    -H 'tus-resumable: 1.0.0' -H 'content-type: application/offset+octet-stream' \
    -H "upload-offset: $off" --data-binary @- -w '\nHTTP %{http_code}' || true)"
  code="$(printf '%s' "$out" | tail -1)"
  got="$(printf '%s' "$out" | sed -n 's/.*"sha256":"\([0-9a-f]*\)".*/\1/p')"
  alive="$(curl -s -o /dev/null -m 5 -w '%{http_code}' -H "authorization: Bearer $TOKEN" "$BASE/api/v1/assets?limit=1" || true)"
  if [ "$code" = "HTTP 200" ] && [ "$got" = "$want" ] && [ "$alive" = 200 ]; then
    ok=$((ok + 1))
    echo "#$i ok offset=$off"
  else
    fail=$((fail + 1))
    echo "#$i FAIL offset=$off code=$code alive=$alive"
    KEEP_LOG=1
  fi
  rm -f "$f"
done
echo "curl replay: ok=$ok fail=$fail total=$N delay=${DELAY}s"
[ "$fail" = 0 ]
