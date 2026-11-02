#!/usr/bin/env bash
# Runs the SDK's end-to-end tests on a private local Stellar network (T8).
# Used locally and in CI. Every key is a throwaway on that network, kept in
# a temporary folder outside the repo and deleted after the run.
#
# Usage: scripts/e2e.sh [vitest options, such as --reporter=verbose]
#
# Build first: `stellar contract build`, then `npm run build`. Set E2E_PORT
# to use a port other than 8000. Set E2E_CONFIG to run another Vitest config
# on the same network, as scripts/keeper-sizing.sh does.
#
# Needs: docker, stellar (CLI 28.1.0), curl and node.
set -euo pipefail

# stellar/quickstart v689-b1585.1-latest: stellar-core v30.0.0, stellar-rpc v30.0.0.
IMAGE="stellar/quickstart@sha256:e05d68bb3b2629a829310dc3434fc0ee3f801854bdfa1a7c8c362d2f1c9060f8"
PORT="${E2E_PORT:-8000}"
CONFIG="${E2E_CONFIG:-vitest.e2e.config.js}"
HEALTH_TIMEOUT=180

cd "$(dirname "$0")/.."

for tool in docker stellar curl npx; do
  if ! command -v "$tool" >/dev/null; then
    echo "${tool} is not on the PATH. The end-to-end tests need docker and the Stellar CLI 28.1.0." >&2
    exit 1
  fi
done
for name in loktin_target_savings loktin_spend_save; do
  if [ ! -f "target/wasm32v1-none/release/${name}.wasm" ]; then
    echo "target/wasm32v1-none/release/${name}.wasm is missing: run 'stellar contract build' first." >&2
    exit 1
  fi
done

CONTAINER="loktin-e2e-$$-${RANDOM}"
cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    echo "== Last 200 lines of the network's log" >&2
    # Quickstart logs its network root secret key at startup. It only
    # controls this throwaway network, but every secret key is masked.
    docker logs --tail 200 "$CONTAINER" 2>&1 |
      sed -E 's/S[A-Z2-7]{55}/S... (masked)/g' >&2 || true
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

echo "== Starting the local network (${CONTAINER}, port ${PORT})"
# Protocol 30 matches testnet after its vote.
docker run -d --name "$CONTAINER" -p "${PORT}:8000" "$IMAGE" \
  --local --limits testnet --protocol-version 30 --enable core,rpc >/dev/null

echo "== Waiting for RPC to report healthy"
started="$(date +%s)"
until curl -fsS -X POST "http://localhost:${PORT}/rpc" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null |
  grep -q '"status":"healthy"'; do
  if [ $(($(date +%s) - started)) -ge "$HEALTH_TIMEOUT" ]; then
    echo "RPC did not report healthy within ${HEALTH_TIMEOUT} s" >&2
    exit 1
  fi
  sleep 2
done
echo "healthy after $(($(date +%s) - started)) s"

E2E_PORT="$PORT" npx vitest run --config "$CONFIG" "$@"
