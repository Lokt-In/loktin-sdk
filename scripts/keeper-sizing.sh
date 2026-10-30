#!/usr/bin/env bash
# Keeper sizing (E3, W114): times keeper sweeps with 1, 2 and 4 channel
# accounts on a private local network that scripts/e2e.sh starts. Local
# only: it refuses any other network. Not part of CI or test:e2e.
#
# Usage: scripts/keeper-sizing.sh [--goals N]
#
# N defaults to 2,000 (100 owners with 20 goals each). Only the full size
# writes docs/keeper-sizing.json; a smaller run prints its table only.
# Build first: `stellar contract build`, then `npm run build`.
set -euo pipefail

goals=2000
while [ "$#" -gt 0 ]; do
  case "$1" in
    --goals)
      goals="${2:-}"
      shift 2 || { echo "--goals needs a number" >&2; exit 1; }
      ;;
    *)
      echo "usage: scripts/keeper-sizing.sh [--goals N]" >&2
      exit 1
      ;;
  esac
done
if ! [[ "$goals" =~ ^[1-9][0-9]*$ ]] || [ "$goals" -gt 2000 ]; then
  echo "--goals must be a whole number from 1 to 2000" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
KEEPER_SIZING_GOALS="$goals" E2E_CONFIG=vitest.sizing.config.js \
  exec bash scripts/e2e.sh --reporter=verbose keeper.sizing
