#!/usr/bin/env bash
# Load and stress test (T10, W71): ramps concurrent users on a private local
# network that scripts/e2e.sh starts, then checks that everything recovers.
# Local only: it refuses any other network. Run by hand or by the weekly
# load-test workflow, never in CI's pull request checks.
#
# Usage: [LOAD_STEPS=10,25,...] [LOAD_OUTPUT=<folder>] scripts/load-test.sh
#
# LOAD_STEPS defaults to 10,25,50,100,200,400,800. The results go to
# <folder>/load-test.json; without LOAD_OUTPUT, a new temporary folder.
# Build first: `stellar contract build`, then `npm run build`.
set -euo pipefail

cd "$(dirname "$0")/.."
if [ -z "${LOAD_OUTPUT:-}" ]; then
  LOAD_OUTPUT="$(mktemp -d "${TMPDIR:-/tmp}/loktin-load.XXXXXX")"
fi
mkdir -p "$LOAD_OUTPUT"
echo "== Results go to ${LOAD_OUTPUT}/load-test.json"
LOAD_OUTPUT="$LOAD_OUTPUT" E2E_CONFIG=vitest.sizing.config.js \
  exec bash scripts/e2e.sh --reporter=verbose load.sizing
