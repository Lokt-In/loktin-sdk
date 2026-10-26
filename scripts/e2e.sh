#!/usr/bin/env bash
# Runs the SDK's end-to-end tests on a private local Stellar network (T8).
# Used locally and in CI. Every key is a throwaway on that network, kept in
# a temporary folder outside the repo and deleted after the run.
#
# Usage: scripts/e2e.sh [vitest options, such as --reporter=verbose]
#
# Build first: `stellar contract build`, then `npm run build`. Set E2E_PORT
# to use a port other than 8000.
#
# Needs: docker, stellar (CLI 28.1.0), curl and node.
set -euo pipefail

# stellar/quickstart v678-b1525.1-latest: stellar-core v29.0.0, stellar-rpc v29.0.1.
IMAGE="stellar/quickstart@sha256:4f8dfd693deba57fddef7f0bc722e4782c2e606c8675e3adc5438cebae249295"
PORT="${E2E_PORT:-8000}"
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
# Protocol 29 matches testnet. The image's default local protocol is 28.
docker run -d --name "$CONTAINER" -p "${PORT}:8000" "$IMAGE" \
  --local --limits testnet --protocol-version 29 --enable core,rpc >/dev/null

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

E2E_PORT="$PORT" npx vitest run --config vitest.e2e.config.js "$@"
