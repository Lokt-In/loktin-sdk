#!/usr/bin/env bash
# Deploys the attested release Wasm to testnet (V5). Run by the owner only.
#
# Usage: scripts/deploy-testnet.sh <folder with the contracts-wasm artifact>
#
# Keys are referred to by alias only. Set these to use other aliases:
#   LOKTIN_DEPLOYER       (default loktin-deployer)       pays for upload and deploy
#   LOKTIN_ADMIN          (default loktin-sdk-admin)      admin role
#   LOKTIN_FEE_ADMIN      (default loktin-fee-admin)      fee-admin role
#   LOKTIN_PAUSER         (default loktin-pauser)         pauser role
#   LOKTIN_UPGRADER       (default loktin-upgrader)       upgrader role
#   LOKTIN_FEE_RECIPIENT  (default loktin-fee-recipient)  receives Loktin fees
#
# Every role needs its own key (C2): the script stops if any two of these
# resolve to the same address.
#
# Needs: stellar (CLI 28.1.0), gh, sha256sum and python3.
set -euo pipefail

REPO="Lokt-In/loktin-sdk"
SIGNER_WORKFLOW="${REPO}/.github/workflows/release-contracts.yml"
NETWORK="testnet"
# Circle testnet USDC.
USDC="CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
# Constraint 7: no Loktin fee this sprint.
LOKTIN_FEE_BPS=0
# C11: 1 day.
MIN_CADENCE=86400

LOKTIN_DEPLOYER="${LOKTIN_DEPLOYER:-loktin-deployer}"
LOKTIN_ADMIN="${LOKTIN_ADMIN:-loktin-sdk-admin}"
LOKTIN_FEE_ADMIN="${LOKTIN_FEE_ADMIN:-loktin-fee-admin}"
LOKTIN_PAUSER="${LOKTIN_PAUSER:-loktin-pauser}"
LOKTIN_UPGRADER="${LOKTIN_UPGRADER:-loktin-upgrader}"
LOKTIN_FEE_RECIPIENT="${LOKTIN_FEE_RECIPIENT:-loktin-fee-recipient}"

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <folder with the contracts-wasm artifact>" >&2
  exit 2
fi
WASM_DIR="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOYMENTS="${ROOT}/deployments/testnet.json"
TARGET_SAVINGS_WASM="${WASM_DIR}/loktin_target_savings.wasm"
SPEND_SAVE_WASM="${WASM_DIR}/loktin_spend_save.wasm"

# Look up every address first, before any file check or network call.
echo "== Looking up role addresses"
address() { stellar keys public-key "$1"; }
DEPLOYER="$(address "$LOKTIN_DEPLOYER")"
ADMIN="$(address "$LOKTIN_ADMIN")"
FEE_ADMIN="$(address "$LOKTIN_FEE_ADMIN")"
PAUSER="$(address "$LOKTIN_PAUSER")"
UPGRADER="$(address "$LOKTIN_UPGRADER")"
FEE_RECIPIENT="$(address "$LOKTIN_FEE_RECIPIENT")"
echo "deployer       ${DEPLOYER}"
echo "admin          ${ADMIN}"
echo "fee-admin      ${FEE_ADMIN}"
echo "pauser         ${PAUSER}"
echo "upgrader       ${UPGRADER}"
echo "fee recipient  ${FEE_RECIPIENT}"

# C2: a separate key per role. Refuse any address used twice.
DUPLICATES="$(printf '%s\n' "$DEPLOYER" "$ADMIN" "$FEE_ADMIN" "$PAUSER" "$UPGRADER" "$FEE_RECIPIENT" \
  | sort | uniq -d)"
if [ -n "$DUPLICATES" ]; then
  echo "refusing to deploy: these addresses hold more than one of deployer, admin," >&2
  echo "fee_admin, pauser, upgrader and fee_recipient:" >&2
  echo "$DUPLICATES" >&2
  echo "Each role needs its own new key (C2). Set the LOKTIN_* variables to separate aliases." >&2
  exit 1
fi

echo "== Checking SHA256SUMS"
(cd "$WASM_DIR" && sha256sum --check --strict SHA256SUMS)

echo "== Verifying the build attestations"
attested() {
  # Prints the source ref and commit the attestation records for a Wasm.
  gh attestation verify "$1" -R "$REPO" --signer-workflow "$SIGNER_WORKFLOW" \
    --format json \
    --jq '.[0].verificationResult.signature.certificate | "\(.sourceRepositoryRef) \(.sourceRepositoryDigest)"'
}
read -r TS_REF TS_COMMIT < <(attested "$TARGET_SAVINGS_WASM")
read -r SS_REF SS_COMMIT < <(attested "$SPEND_SAVE_WASM")
if [ -z "$TS_COMMIT" ] || [ "$TS_REF $TS_COMMIT" != "$SS_REF $SS_COMMIT" ]; then
  echo "the two Wasm files were not attested by the same release build" >&2
  exit 1
fi
RELEASE_TAG="${TS_REF#refs/tags/}"
COMMIT="$TS_COMMIT"
echo "release ${RELEASE_TAG} at commit ${COMMIT}"

echo "== Uploading Wasm"
upload() {
  stellar contract upload --wasm "$1" --source-account "$LOKTIN_DEPLOYER" --network "$NETWORK"
}
TS_HASH="$(upload "$TARGET_SAVINGS_WASM")"
SS_HASH="$(upload "$SPEND_SAVE_WASM")"
# The uploaded hash is the Wasm's sha256, so it must match SHA256SUMS.
for pair in "${TS_HASH}:loktin_target_savings.wasm" "${SS_HASH}:loktin_spend_save.wasm"; do
  if ! grep -qx "${pair%%:*}  ${pair#*:}" "${WASM_DIR}/SHA256SUMS"; then
    echo "uploaded hash for ${pair#*:} does not match SHA256SUMS" >&2
    exit 1
  fi
done

echo "== Deploying Target Savings"
TS_ID="$(stellar contract deploy --wasm-hash "$TS_HASH" \
  --source-account "$LOKTIN_DEPLOYER" --network "$NETWORK" -- \
  --admin "$ADMIN" \
  --fee_admin "$FEE_ADMIN" \
  --pauser "$PAUSER" \
  --upgrader "$UPGRADER" \
  --token "$USDC" \
  --fee_recipient "$FEE_RECIPIENT" \
  --loktin_fee_bps "$LOKTIN_FEE_BPS" \
  --min_cadence "$MIN_CADENCE")"

echo "== Deploying Spend & Save"
# target_savings is an Option<Address>. Stellar CLI 28.1.0 parses every
# argument that is not a primitive type as JSON, so the id is passed as a
# JSON string, quotes included. yield_source is omitted, which gives None.
SS_ID="$(stellar contract deploy --wasm-hash "$SS_HASH" \
  --source-account "$LOKTIN_DEPLOYER" --network "$NETWORK" -- \
  --admin "$ADMIN" \
  --fee_admin "$FEE_ADMIN" \
  --pauser "$PAUSER" \
  --upgrader "$UPGRADER" \
  --token "$USDC" \
  --fee_recipient "$FEE_RECIPIENT" \
  --loktin_fee_bps "$LOKTIN_FEE_BPS" \
  --target_savings "\"${TS_ID}\"")"

echo "== Recording the deployment in ${DEPLOYMENTS}"
python3 -I - "$DEPLOYMENTS" "$TS_ID" "$TS_HASH" "$SS_ID" "$SS_HASH" "$RELEASE_TAG" "$COMMIT" \
  "$ADMIN" "$FEE_ADMIN" "$PAUSER" "$UPGRADER" "$FEE_RECIPIENT" <<'PY'
import json
import sys

(path, ts_id, ts_hash, ss_id, ss_hash, tag, commit,
 admin, fee_admin, pauser, upgrader, fee_recipient) = sys.argv[1:]
with open(path) as f:
    data = json.load(f)
# Public addresses only, so anyone can verify the deployment.
data["roles"] = {
    "admin": admin,
    "fee_admin": fee_admin,
    "pauser": pauser,
    "upgrader": upgrader,
    "fee_recipient": fee_recipient,
}
for name, contract_id, wasm_hash in (
    ("target_savings", ts_id, ts_hash),
    ("spend_save", ss_id, ss_hash),
):
    data["contracts"][name] = {
        "id": contract_id,
        "wasm_hash": wasm_hash,
        "release_tag": tag,
        "commit": commit,
    }
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY

echo "target_savings  id ${TS_ID}"
echo "                wasm_hash ${TS_HASH}"
echo "spend_save      id ${SS_ID}"
echo "                wasm_hash ${SS_HASH}"
echo "release_tag     ${RELEASE_TAG}"
echo "commit          ${COMMIT}"
