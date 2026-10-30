#!/usr/bin/env bash
# Read overhead (T10, W70): times reads through the SDK against the same
# simulation sent straight to the RPC, on a private local network that
# scripts/e2e.sh starts. Local only: it refuses any other network. Not part
# of CI or test:e2e.
#
# Usage: scripts/read-overhead.sh
#
# Build first: `stellar contract build`, then `npm run build`.
set -euo pipefail

cd "$(dirname "$0")/.."
E2E_CONFIG=vitest.sizing.config.js \
  exec bash scripts/e2e.sh --reporter=verbose read-overhead.sizing
