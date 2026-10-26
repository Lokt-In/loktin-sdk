#!/usr/bin/env bash
# Upgrades the recorded testnet contracts in place to an attested release
# (C5). Run by the owner only.
#
# Usage: scripts/upgrade-testnet.sh <folder with the contracts-wasm artifact> <release tag>
#
# Keys are referred to by alias only. Set these to use other aliases:
#   LOKTIN_DEPLOYER  (default loktin-deployer)  pays for the uploads
#   LOKTIN_UPGRADER  (default loktin-upgrader)  holds the upgrader role and calls upgrade
#
# Before any network call, the script checks SHA256SUMS, each Wasm's
# metadata, and that the upgrader alias is the recorded upgrader. Check each
# file's attestation with `gh attestation verify` first (docs/deploy.md).
#
# Needs: stellar (CLI 28.1.0), git, sha256sum and python3.
set -euo pipefail

NETWORK="testnet"
SOURCE_REPO="github:Lokt-In/loktin-sdk"

LOKTIN_DEPLOYER="${LOKTIN_DEPLOYER:-loktin-deployer}"
LOKTIN_UPGRADER="${LOKTIN_UPGRADER:-loktin-upgrader}"

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <folder with the contracts-wasm artifact> <release tag>" >&2
  exit 2
fi
WASM_DIR="$1"
RELEASE_TAG="$2"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOYMENTS="${ROOT}/deployments/testnet.json"

case "$RELEASE_TAG" in
  contracts-v[0-9]*) ;;
  *)
    echo "the release tag must look like contracts-v0.2.0, not '${RELEASE_TAG}'" >&2
    exit 2
    ;;
esac
BINVER="${RELEASE_TAG#contracts-v}"
if ! COMMIT="$(git -C "$ROOT" rev-list -n 1 "refs/tags/${RELEASE_TAG}" 2>/dev/null)"; then
  echo "tag ${RELEASE_TAG} is not in this clone: run git fetch --tags" >&2
  exit 1
fi

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

echo "== Checking SHA256SUMS"
(cd "$WASM_DIR" && sha256sum --check --strict SHA256SUMS)

echo "== Checking the Wasm metadata"
for name in loktin_target_savings loktin_spend_save; do
  wasm="${WASM_DIR}/${name}.wasm"
  meta="$(stellar contract info meta --wasm "$wasm" --output json)"
  for pair in "source_repo:${SOURCE_REPO}" "binver:${BINVER}"; do
    if ! grep -qF "{\"key\":\"${pair%%:*}\",\"val\":\"${pair#*:}\"}" <<<"$meta"; then
      echo "${wasm} does not have ${pair%%:*}=${pair#*:} in its metadata" >&2
      exit 1
    fi
  done
  echo "${name}: source_repo ${SOURCE_REPO}, binver ${BINVER}"
done

echo "== Checking the upgrader"
UPGRADER="$(stellar keys public-key "$LOKTIN_UPGRADER")"
RECORDED_UPGRADER="$(field roles.upgrader)"
echo "upgrader alias ${LOKTIN_UPGRADER}: ${UPGRADER}"
if [ "$UPGRADER" != "$RECORDED_UPGRADER" ]; then
  echo "refusing to upgrade: ${LOKTIN_UPGRADER} is not the recorded upgrader ${RECORDED_UPGRADER}" >&2
  exit 1
fi
echo "release ${RELEASE_TAG} at commit ${COMMIT}"

# Records one contract's new release, keeping its earlier ones in `history`.
record() {
  python3 -I - "$DEPLOYMENTS" "$1" "$2" "$RELEASE_TAG" "$COMMIT" <<'PY'
import json
import sys

path, name, wasm_hash, tag, commit = sys.argv[1:]
with open(path) as f:
    data = json.load(f)
contract = data["contracts"][name]
history = contract.get("history")
if history is None:
    # The release in place before the first upgrade.
    history = [
        {
            "release_tag": contract["release_tag"],
            "wasm_hash": contract["wasm_hash"],
            "commit": contract["commit"],
        }
    ]
release = {"release_tag": tag, "wasm_hash": wasm_hash, "commit": commit}
if history[-1] != release:
    history.append(release)
contract.update(wasm_hash=wasm_hash, release_tag=tag, commit=commit, history=history)
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
}

for pair in "target_savings:loktin_target_savings" "spend_save:loktin_spend_save"; do
  name="${pair%%:*}"
  wasm="${WASM_DIR}/${pair#*:}.wasm"
  id="$(field "contracts.${name}.id")"
  echo "== Upgrading ${name} (${id})"
  expected="$(sha256sum "$wasm" | cut -d' ' -f1)"
  hash="$(stellar contract upload --wasm "$wasm" --source-account "$LOKTIN_DEPLOYER" --network "$NETWORK")"
  # The uploaded hash is the Wasm's sha256.
  if [ "$hash" != "$expected" ]; then
    echo "uploaded hash ${hash} does not match the file's sha256 ${expected}" >&2
    exit 1
  fi
  stellar contract invoke --id "$id" --source-account "$LOKTIN_UPGRADER" --network "$NETWORK" -- \
    upgrade --new_wasm_hash "$hash" --operator "$UPGRADER"
  # Recorded right away, so the file is right even if a later step fails.
  record "$name" "$hash"
  echo "${name}  wasm_hash ${hash}"
done

echo "== Recorded ${RELEASE_TAG} (${COMMIT}) in ${DEPLOYMENTS}"
