#!/bin/sh
# Install, upgrade, roll back or remove qiu-creator (QC-032). See deploy/README.md.
# Without --yes this only prints what it would do.
set -eu
cd "$(dirname "$0")/.."
exec corepack pnpm --silent --filter @qiu-creator/installer exec tsx src/cli.ts "$@"
