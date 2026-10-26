# Testnet deploy runbook

This is the owner's runbook for deploying both contracts to testnet (V5). The owner creates every key and runs every deploy. Keys stay on the owner's machine, in the Stellar CLI's key store, and never enter the repo. The scripts refer to keys by alias only and print public addresses, never secrets.

You need the Stellar CLI 28.1.0, the GitHub CLI (`gh`), `sha256sum` and `python3`.

## Key aliases

| Alias                  | Role                                                     |
| ---------------------- | -------------------------------------------------------- |
| `loktin-deployer`      | Pays for the Wasm upload and the deploys. Holds no role. |
| `loktin-sdk-admin`     | Admin: grants and revokes roles (C2).                    |
| `loktin-fee-admin`     | Fee-admin: sets the Loktin fee rate and recipient (R6).  |
| `loktin-pauser`        | Pauser: pauses and unpauses (C4).                        |
| `loktin-upgrader`      | Upgrader: replaces the contract code (C5).               |
| `loktin-fee-recipient` | Receives Loktin fees. Holds no role.                     |

To use other alias names, set `LOKTIN_DEPLOYER`, `LOKTIN_ADMIN`, `LOKTIN_FEE_ADMIN`, `LOKTIN_PAUSER`, `LOKTIN_UPGRADER` and `LOKTIN_FEE_RECIPIENT` before running `deploy-testnet.sh`.

## Steps

1. Create and fund the six aliases, one at a time:

   ```sh
   stellar keys generate loktin-deployer --network testnet --fund
   stellar keys generate loktin-sdk-admin --network testnet --fund
   stellar keys generate loktin-fee-admin --network testnet --fund
   stellar keys generate loktin-pauser --network testnet --fund
   stellar keys generate loktin-upgrader --network testnet --fund
   stellar keys generate loktin-fee-recipient --network testnet --fund
   ```

   Use alias names that are new for this deployment. If `stellar keys generate` says a name already exists, do not reuse that key: pick a new name and set the matching `LOKTIN_*` variable. Each role must have its own new key (C2).

2. Push a release tag to run the release workflow (`.github/workflows/release-contracts.yml`). Push it on the merged `main` commit, after the pull request that adds the release workflow and these scripts is merged:

   ```sh
   git switch main
   git pull
   git tag contracts-v0.1.0
   git push origin contracts-v0.1.0
   ```

   A tag is never moved or reused. A new release gets a new tag.

   The workflow builds both contracts with `source_repo=github:Lokt-In/loktin-sdk` in their metadata, attests the two Wasm files and uploads them with a `SHA256SUMS` file.

3. When the workflow has finished, download its artifact. Use the run id that `gh run list --workflow release-contracts.yml` shows:

   ```sh
   gh run download <run-id> -n contracts-wasm -D <dir>
   ```

4. Deploy:

   ```sh
   scripts/deploy-testnet.sh <dir>
   ```

   The script stops on the first failure. It:
   - checks `SHA256SUMS`;
   - verifies each Wasm's attestation against this repo and the release workflow, and reads the release tag and commit from it;
   - uploads both Wasm files;
   - deploys Target Savings with Circle's testnet USDC, a 0% Loktin fee, a 1-day minimum cadence and no yield source;
   - deploys Spend & Save the same way, linked to the new Target Savings contract;
   - writes both contract ids, Wasm hashes, the release tag and the commit into `deployments/testnet.json`, together with the public addresses of the admin, fee-admin, pauser, upgrader and fee recipient, and prints them.

5. Verify, read-only:

   ```sh
   scripts/verify-testnet.sh
   ```

   It prints PASS or FAIL for each check and exits non-zero on any FAIL. It checks each contract's metadata (`binver` and `source_repo`), compares the on-chain Wasm hash with the recorded one, reads the configuration through simulation, and checks the admin and every role holder.

   It reads the contract ids and role addresses from `deployments/testnet.json` and needs no key alias, so anyone can run it. Simulations need a funded testnet account as their source, which never signs anything. Set `LOKTIN_SOURCE` to its address or alias; it defaults to the recorded admin address.

6. Commit the updated `deployments/testnet.json` through a pull request. Contract ids are public, not secrets.

## Upgrading

An upgrade replaces the code of the recorded contracts in place, so their ids stay the same (C5). Each upgrade has a decision note in `docs/decisions` that explains why the stored records stay readable. The first one is `contracts-v0.2.0`, which adds accrued fees (0002).

1. After the pull request with the new contract version is merged, tag the merged `main` commit and push the tag:

   ```sh
   git switch main
   git pull
   git tag contracts-v0.2.0
   git push origin contracts-v0.2.0
   ```

2. Wait for the release workflow (`.github/workflows/release-contracts.yml`) to finish.
3. Download its artifact, with the run id that `gh run list --workflow release-contracts.yml` shows:

   ```sh
   gh run download <run-id> -n contracts-wasm -D <dir>
   ```

4. Check each file's attestation:

   ```sh
   gh attestation verify <dir>/loktin_target_savings.wasm -R Lokt-In/loktin-sdk
   gh attestation verify <dir>/loktin_spend_save.wasm -R Lokt-In/loktin-sdk
   ```

5. Run the upgrade, then the verify script:

   ```sh
   scripts/upgrade-testnet.sh <dir> contracts-v0.2.0
   scripts/verify-testnet.sh
   ```

   The upgrade script uses `loktin-deployer` to pay for the uploads and `loktin-upgrader` to call `upgrade`. Set `LOKTIN_DEPLOYER` and `LOKTIN_UPGRADER` to use other aliases. Before any network call it stops unless:
   - `SHA256SUMS` in the folder verifies;
   - each Wasm's metadata has `source_repo=github:Lokt-In/loktin-sdk` and a `binver` equal to the tag's version (`0.2.0` for `contracts-v0.2.0`);
   - the upgrader alias's address is the `roles.upgrader` recorded in `deployments/testnet.json`.

   Then, for each contract, it uploads the Wasm, stops if the returned hash differs from the file's sha256, and calls `upgrade` on the recorded contract id. After each upgrade it records the new `wasm_hash`, `release_tag` and `commit` in `deployments/testnet.json`, and adds the release to the contract's `history` list, which keeps the earlier releases.

   The verify script then expects each contract's `binver` to match its recorded release tag, and checks that `accrued_fees` answers, which shows the new code is live.

6. Open a pull request with the `deployments/testnet.json` change.

## Not yet covered

The SDK-based testnet smoke script (V6) comes in part 7, once the SDK exists.
