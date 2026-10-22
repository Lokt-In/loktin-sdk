#!/usr/bin/env bash
# Checks the testnet deployment recorded in a deployments file (V5).
# Read-only: every contract call is a simulation, nothing is signed or sent.
#
# Usage: scripts/verify-testnet.sh [deployments/testnet.json]
#
# Contract ids and role holders are read from the deployments file, so no
# key alias is needed. Simulations need a funded testnet account as their
# source: set LOKTIN_SOURCE to its address or alias. It defaults to the
# recorded admin address.
#
# Needs: stellar (CLI 28.1.0), sha256sum and python3.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOYMENTS="${1:-${ROOT}/deployments/testnet.json}"
NETWORK="testnet"
SOURCE_REPO="github:Lokt-In/loktin-sdk"
BINVER="0.1.0"
EXPECTED_FEE_BPS=0
EXPECTED_MIN_CADENCE=86400

FAILURES=0
pass() { echo "PASS  $1"; }
fail() {
  echo "FAIL  $1"
  FAILURES=$((FAILURES + 1))
}
# check <description> <actual> <expected>
check() {
  if [ "$2" = "$3" ]; then
    pass "$1"
  else
    fail "$1 (got '$2', expected '$3')"
  fi
}

field() {
  python3 -I - "$DEPLOYMENTS" "$1" <<'PY'
import json
import sys

value = json.load(open(sys.argv[1]))
for part in sys.argv[2].split("."):
    value = value[part]
print(value)
PY
}

# True when the JSON meta output holds key=value.
has_meta() {
  grep -qF "{\"key\":\"$2\",\"val\":\"$3\"}" <<<"$1"
}

USDC="$(field usdc)"
ADMIN="$(field roles.admin)"
FEE_ADMIN="$(field roles.fee_admin)"
PAUSER="$(field roles.pauser)"
UPGRADER="$(field roles.upgrader)"
FEE_RECIPIENT="$(field roles.fee_recipient)"
TS_ID="$(field contracts.target_savings.id)"
SOURCE="${LOKTIN_SOURCE:-$ADMIN}"

for role in admin fee_admin pauser upgrader fee_recipient; do
  if [ -z "$(field "roles.${role}")" ]; then
    fail "roles: no ${role} address recorded"
  fi
done
if [ -z "$SOURCE" ]; then
  echo "no source account: set LOKTIN_SOURCE or record roles.admin" >&2
  exit 1
fi

# Simulates a read. The source account is never asked to sign.
read_fn() {
  local id="$1"
  shift
  stellar contract invoke --id "$id" --source-account "$SOURCE" --network "$NETWORK" \
    --send no -- "$@" 2>/dev/null | tr -d '"'
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for name in target_savings spend_save; do
  echo "== ${name}"
  id="$(field "contracts.${name}.id")"
  recorded_hash="$(field "contracts.${name}.wasm_hash")"
  if [ -z "$id" ]; then
    fail "${name}: no contract id recorded"
    continue
  fi
  echo "contract ${id}"

  stellar contract info meta --contract-id "$id" --network "$NETWORK"
  meta="$(stellar contract info meta --contract-id "$id" --network "$NETWORK" --output json 2>/dev/null)"
  if has_meta "$meta" binver "$BINVER"; then pass "${name}: binver ${BINVER}"; else fail "${name}: binver ${BINVER}"; fi
  if has_meta "$meta" source_repo "$SOURCE_REPO"; then
    pass "${name}: source_repo ${SOURCE_REPO}"
  else
    fail "${name}: source_repo ${SOURCE_REPO}"
  fi

  if stellar contract fetch --id "$id" --network "$NETWORK" -o "${WORK}/${name}.wasm" 2>/dev/null; then
    onchain_hash="$(sha256sum "${WORK}/${name}.wasm" | cut -d' ' -f1)"
    check "${name}: on-chain Wasm hash matches the recorded hash" "$onchain_hash" "$recorded_hash"
  else
    fail "${name}: could not fetch the on-chain Wasm"
  fi

  check "${name}: token" "$(read_fn "$id" token)" "$USDC"
  check "${name}: loktin_fee_bps" "$(read_fn "$id" loktin_fee_bps)" "$EXPECTED_FEE_BPS"
  check "${name}: fee_recipient" "$(read_fn "$id" fee_recipient)" "$FEE_RECIPIENT"
  if [ "$name" = "target_savings" ]; then
    check "${name}: min_cadence" "$(read_fn "$id" min_cadence)" "$EXPECTED_MIN_CADENCE"
  else
    check "${name}: target_savings" "$(read_fn "$id" target_savings)" "$TS_ID"
  fi

  check "${name}: get_admin" "$(read_fn "$id" get_admin)" "$ADMIN"
  for role_and_holder in "fee_admin:${FEE_ADMIN}" "pauser:${PAUSER}" "upgrader:${UPGRADER}"; do
    role="${role_and_holder%%:*}"
    holder="${role_and_holder#*:}"
    index="$(read_fn "$id" has_role --account "$holder" --role "$role")"
    if [[ "$index" =~ ^[0-9]+$ ]]; then
      pass "${name}: ${holder} holds ${role}"
    else
      fail "${name}: ${holder} holds ${role} (got '${index}')"
    fi
  done
done

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "${FAILURES} check(s) failed"
  exit 1
fi
echo "all checks passed"
