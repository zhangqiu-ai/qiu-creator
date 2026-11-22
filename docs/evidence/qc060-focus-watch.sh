#!/bin/sh
# QC-060: sample the frontmost app and the Electron processes' Dock/⌘Tab visibility while a command runs.
# Usage: qc060-focus-watch.sh <out-file> <command...>
out="$1"; shift
: > "$out"
front() { osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null; }
electrons() {
  osascript -e 'tell application "System Events" to get {name, background only} of (every application process whose name is "Electron")' 2>/dev/null
}
echo "before: $(front)" >> "$out"
( while :; do echo "$(date +%T) front=$(front) electron=[$(electrons)]" >> "$out"; sleep 0.25; done ) &
sampler=$!
"$@"
status=$?
kill $sampler 2>/dev/null; wait $sampler 2>/dev/null
echo "after: $(front)" >> "$out"
exit $status
