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

6. Extend each new code entry from the deployer, so the first user call does not pay the rent for it. The first call after the 0.3.0 upgrade paid 53.46 XLM of rent. Use each contract's new `wasm_hash` from `deployments/testnet.json`:

   ```sh
   stellar contract extend --wasm-hash <target_savings wasm_hash> --ledgers-to-extend 3110399 --source-account loktin-deployer --network testnet
   stellar contract extend --wasm-hash <spend_save wasm_hash> --ledgers-to-extend 3110399 --source-account loktin-deployer --network testnet
   ```

7. Open a pull request with the `deployments/testnet.json` change.

## Testnet smoke run

The smoke script runs every user flow through the SDK on testnet and writes each transaction hash to an evidence file (V6). You run it with your own keys. It signs each transaction with `stellar tx sign`, so every secret stays in the Stellar CLI keystore, and nothing secret is printed or written.

### Aliases

| Alias                       | Role                        |
| --------------------------- | --------------------------- |
| `loktin-smoke-user-a`       | User A                      |
| `loktin-smoke-user-b`       | User B                      |
| `loktin-smoke-integrator-a` | Integrator A, charging 0.5% |
| `loktin-smoke-integrator-b` | Integrator B, charging 1%   |

To use other alias names, set `LOKTIN_SMOKE_USER_A`, `LOKTIN_SMOKE_USER_B`, `LOKTIN_SMOKE_INTEGRATOR_A` and `LOKTIN_SMOKE_INTEGRATOR_B`.

### Setup

1. Create and fund the four aliases, one at a time:

   ```sh
   stellar keys generate loktin-smoke-user-a --network testnet --fund
   stellar keys generate loktin-smoke-user-b --network testnet --fund
   stellar keys generate loktin-smoke-integrator-a --network testnet --fund
   stellar keys generate loktin-smoke-integrator-b --network testnet --fund
   ```

2. Add a USDC trustline to all four. The integrators need one to claim their fees:

   ```sh
   stellar tx new change-trust --line USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --source-account loktin-smoke-user-a --network testnet
   stellar tx new change-trust --line USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --source-account loktin-smoke-user-b --network testnet
   stellar tx new change-trust --line USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --source-account loktin-smoke-integrator-a --network testnet
   stellar tx new change-trust --line USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --source-account loktin-smoke-integrator-b --network testnet
   ```

3. Take 20 USDC from [faucet.circle.com](https://faucet.circle.com) for each user, on Stellar testnet. The faucet gives one request per address every 2 hours.
4. From an up-to-date `main`:

   ```sh
   npm ci
   npm run build
   ```

### The three phases

Run them in this order, each with:

```sh
node packages/sdk/smoke/testnet-smoke.ts <phase>
```

Before any write, every phase checks that each alias has at least 10 XLM and a USDC trustline, and that each user holds enough USDC for the phase. If anything is short, it says what and for which alias, and stops.

1. `goals`, as soon as possible. It creates the two evidence goals the keeper collects: user A with a 5% penalty through integrator A, and user B with a lock through integrator B, each with a 5 USDC target, 1 USDC daily deposits and a deadline 7 days and 1 hour away, with the allowance approved. If a matching goal is already open, it is reused, so a rerun is safe. The goals must exist by 31 October. It writes `evidence/evidence-goals.json`.
2. `run`. It runs the flows: penalty and lock goals for each user, the expected refusals (`NotOwner`, `Locked` and `OutsideWindow`), user A's two Spend & Save enrolments, and both integrators' Target Savings fee claims. Then it takes the latency sample: 50 small deposits and 300 reads, with p50, p95 and maximum set against the targets of reads under 1 second and writes under 15 seconds at p95. Every goal it creates is closed again before it ends, and it never changes the evidence goals' allowance. It needs 9.6125 USDC for user A and 7.25 USDC for user B, which includes 5 USDC each kept for the evidence goals. A rerun needs the same. It writes `evidence/testnet-smoke.json`.

   `run` needs `goals` first: without both evidence goals open, it stops before any write. If it stops partway, look up any pending hash it printed on stellar.expert, then run it again. It first closes every other goal the stopped run left open, recording each as a tidy-up step, updates an enrolment that already exists instead of enrolling again, and carries on.

3. `window`, on 1 November UTC. It refuses to start on any other day. It withdraws user A's Spend & Save balances with both integrators, closes both enrolments, and claims both integrators' Spend & Save fees. It writes `evidence/testnet-smoke-window.json`.

Each evidence file holds the network, the contract ids, the SDK version and git commit, the aliases with their public addresses, and for every transaction its hash, ledger, fee, time and a stellar.expert link. It is written after every step, with `"complete": false` until the phase ends. Any unexpected error stops the phase and is recorded. If a transaction's outcome is not known in time, its hash is recorded and the phase stops without sending it again: look it up on stellar.expert before running the phase again.

Commit the evidence files through a pull request, so they can be checked against the chain.

## Evidence keeper

The `Evidence keeper` workflow (`.github/workflows/evidence-keeper.yml`) runs one keeper pass every hour, at 17 minutes past, and can also be started by hand (V7). Each pass scans the testnet Target Savings goals of the smoke run's two integrators, from the contract's events and the two smoke users' goal lists, and collects every goal that is due. It writes one JSON line per goal and a summary line to the run's log, with public keys and hashes only. Those logs are the keeper evidence, and GitHub keeps them for 90 days.

The keeper's key holds only XLM for fees and has no role and no power over anyone's funds. Set it up once:

1. Create and fund the key:

   ```sh
   stellar keys generate loktin-keeper --network testnet --fund
   ```

2. Store its secret as the repository secret the workflow reads. The secret goes straight from the keystore to GitHub and is never shown:

   ```sh
   stellar keys secret loktin-keeper | gh secret set LOKTIN_KEEPER_SECRET --repo Lokt-In/loktin-sdk
   ```

3. Start the first run by hand, then check its log:

   ```sh
   gh workflow run evidence-keeper.yml --repo Lokt-In/loktin-sdk
   ```

The workflow passes the secret only to the keeper step, which writes it to a file readable only by the runner, runs the keeper with that file, and deletes it in every case. A run exits non-zero on an unexpected error; expected skips, such as a goal that is not due yet, are logged and the run still passes.
