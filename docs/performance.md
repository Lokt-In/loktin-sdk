# Performance

What the contracts and the SDK cost to run, measured against our own targets (T10, W70). No published industry standard for these figures was found, so the thresholds and targets here are our own judgments.

## Contract resources

Each public function that writes, and the main reads, run in a test on the release Wasm, each in its worst realistic state. Every figure must stay under 25% of testnet's per-transaction limit, read on 2026-10-30 with `stellar network settings --network testnet`. The tests are `contracts/target-savings/tests/budgets.rs` and `contracts/spend-save/tests/budgets.rs`, and the limits live in `contracts/common/src/budgets.rs`, compiled for tests only.

The figures come from soroban-sdk's `env.cost_estimate().resources()`, which does not model the transaction's own size. Auths are mocked, so signature checks are not counted, and the test addresses are contract addresses, so token balances are contract data rather than classic trustlines read from disk.

| Limit             | Testnet limit | 25% line    |
| ----------------- | ------------- | ----------- |
| Instructions      | 400,000,000   | 100,000,000 |
| Memory (bytes)    | 41,943,040    | 10,485,760  |
| Disk read entries | 200           | 50          |
| Disk read bytes   | 200,000       | 50,000      |
| Write entries     | 200           | 50          |
| Write bytes       | 132,096       | 33,024      |
| Event bytes       | 16,384        | 4,096       |

### Target Savings

| Function                                                     | Instructions | Memory (bytes) | Disk read entries | Disk read bytes | Write entries | Write bytes | Event bytes |
| ------------------------------------------------------------ | ------------ | -------------- | ----------------- | --------------- | ------------- | ----------- | ----------- |
| `create_goal`, with an allowance, owner already has 19 goals | 1,142,271    | 1,327,120      | 0                 | 0               | 5             | 1,580       | 728         |
| `deposit`, owner with 20 goals                               | 1,046,608    | 1,319,791      | 1                 | 92              | 4             | 1,216       | 488         |
| `collect`, after two missed periods                          | 1,214,597    | 1,347,140      | 1                 | 92              | 4             | 1,436       | 644         |
| `withdraw`, with a penalty and both fees, first of 20 goals  | 1,272,352    | 1,351,291      | 0                 | 0               | 7             | 1,184       | 700         |
| `claim_fees`                                                 | 858,666      | 1,288,881      | 1                 | 92              | 4             | 520         | 396         |
| `user_goals`, 20 open goals                                  | 2,563,676    | 1,348,618      | 0                 | 0               | 0             | 0           | 0           |
| `goal`                                                       | 628,770      | 1,246,258      | 0                 | 0               | 0             | 0           | 0           |
| `set_loktin_fee`                                             | 713,987      | 1,260,948      | 0                 | 0               | 2             | 540         | 120         |
| `set_fee_recipient`                                          | 711,482      | 1,259,142      | 0                 | 0               | 2             | 540         | 156         |
| `pause`                                                      | 689,624      | 1,260,038      | 0                 | 0               | 2             | 576         | 80          |
| `unpause`                                                    | 681,575      | 1,259,224      | 0                 | 0               | 2             | 576         | 80          |
| `upgrade`                                                    | 667,049      | 1,259,406      | 0                 | 0               | 2             | 540         | 420         |
| `grant_role`                                                 | 770,076      | 1,265,318      | 0                 | 0               | 4             | 532         | 196         |
| `revoke_role`                                                | 825,924      | 1,265,223      | 0                 | 0               | 4             | 192         | 196         |
| `renounce_role`                                              | 860,743      | 1,270,472      | 0                 | 0               | 5             | 332         | 196         |
| `set_role_admin`                                             | 650,714      | 1,252,411      | 0                 | 0               | 2             | 192         | 184         |
| `transfer_admin_role`                                        | 671,118      | 1,257,331      | 0                 | 0               | 2             | 264         | 232         |
| `accept_admin_transfer`                                      | 699,528      | 1,262,354      | 0                 | 0               | 3             | 540         | 200         |
| `renounce_admin`                                             | 659,773      | 1,256,933      | 0                 | 0               | 2             | 472         | 128         |

### Spend & Save

| Function                                                                         | Instructions | Memory (bytes) | Disk read entries | Disk read bytes | Write entries | Write bytes | Event bytes |
| -------------------------------------------------------------------------------- | ------------ | -------------- | ----------------- | --------------- | ------------- | ----------- | ----------- |
| `enroll`, the fifth enrolment, into a goal                                       | 905,639      | 1,287,784      | 0                 | 0               | 3             | 1,296       | 452         |
| `update_settings`, with five enrolments                                          | 880,904      | 1,280,749      | 0                 | 0               | 2             | 972         | 456         |
| `pay_and_save`, percentage, round-up and monthly cap, into a Target Savings goal | 2,793,231    | 2,702,153      | 1                 | 92              | 6             | 2,308       | 1,380       |
| `save_for_spend`, the same, into a Target Savings goal                           | 2,584,084    | 2,701,985      | 1                 | 92              | 5             | 2,084       | 900         |
| `withdraw`, with both fees                                                       | 1,190,901    | 1,329,094      | 0                 | 0               | 6             | 1,688       | 556         |
| `close`, the first of five enrolments                                            | 773,435      | 1,271,284      | 0                 | 0               | 3             | 376         | 172         |
| `claim_fees`                                                                     | 857,040      | 1,298,268      | 1                 | 92              | 4             | 520         | 396         |
| `set_loktin_fee`                                                                 | 718,278      | 1,269,120      | 0                 | 0               | 2             | 572         | 120         |
| `set_fee_recipient`                                                              | 712,215      | 1,265,002      | 0                 | 0               | 2             | 572         | 156         |
| `pause`                                                                          | 699,038      | 1,268,183      | 0                 | 0               | 2             | 608         | 80          |
| `unpause`                                                                        | 686,969      | 1,265,057      | 0                 | 0               | 2             | 608         | 80          |
| `upgrade`                                                                        | 679,199      | 1,267,468      | 0                 | 0               | 2             | 572         | 420         |
| `grant_role`                                                                     | 796,009      | 1,278,078      | 0                 | 0               | 4             | 532         | 196         |
| `revoke_role`                                                                    | 834,130      | 1,275,671      | 0                 | 0               | 4             | 192         | 196         |
| `renounce_role`                                                                  | 891,952      | 1,283,149      | 0                 | 0               | 5             | 332         | 196         |
| `set_role_admin`                                                                 | 650,620      | 1,258,235      | 0                 | 0               | 2             | 192         | 184         |
| `transfer_admin_role`                                                            | 676,556      | 1,265,467      | 0                 | 0               | 2             | 264         | 232         |
| `accept_admin_transfer`                                                          | 705,860      | 1,270,496      | 0                 | 0               | 3             | 572         | 200         |
| `renounce_admin`                                                                 | 657,773      | 1,262,763      | 0                 | 0               | 2             | 504         | 128         |

Every figure is far under its 25% line. The largest share is event bytes for `pay_and_save`, at about 34% of the 25% line (1,380 of 4,096), which is under 9% of the testnet limit. Rerun the figures with `cargo test -p loktin-target-savings --test budgets -- --nocapture` and the same for `loktin-spend-save`, after `stellar contract build`.

## SDK bundle size

Each export bundled on its own as minified ESM, with `@stellar/stellar-sdk` left out as the peer dependency it is, then gzipped at level 9. The sizes are recorded in `packages/sdk/bundle-size.json`. CI's `npm run size:check` fails if any of them grows by more than 10%, and `npm run size:update` records new sizes when a growth is intended.

| Export                       | Minified (bytes) | Gzipped (bytes) |
| ---------------------------- | ---------------- | --------------- |
| `@loktin/sdk`                | 63,011           | 16,863          |
| `@loktin/sdk/target-savings` | 58,964           | 14,845          |
| `@loktin/sdk/spend-save`     | 57,256           | 14,049          |
| `@loktin/sdk/keeper`         | 58,298           | 15,383          |

Each subpath includes the shared core and the bundled contract specs, so the sizes do not add up: an app that uses several exports ships the core once.

## Read overhead

Target (W70): the SDK adds no more than about 50 ms of its own to a read on the local network.

`npm run sizing:reads` starts the private local network and refuses any other. It times 200 reads of one goal through the SDK, and 200 of the same simulation sent straight to the RPC with a transaction built once, in alternating blocks of 20, after 10 warm-up calls of each. Run on 30 October 2026:

| Path              | Calls | p50     | p95     |
| ----------------- | ----- | ------- | ------- |
| Through the SDK   | 200   | 43.9 ms | 63.3 ms |
| Direct simulation | 200   | 41.4 ms | 50.5 ms |
| Added by the SDK  |       | 2.5 ms  | 12.8 ms |

The SDK adds about 3 ms at the median and 13 ms at the 95th percentile, well under the 50 ms target.

## Testnet latency

Targets (W70): reads under 1 s at the 95th percentile on the public testnet RPC, and writes confirmed within about 15 s (3 ledgers) at the 95th percentile, not counting the user's signing time. The sample is the owner's testnet smoke run, in `evidence/testnet-smoke.json`:

| Sample | Count | p50      | p95      | Max       | Target (p95) | Met |
| ------ | ----- | -------- | -------- | --------- | ------------ | --- |
| Reads  | 300   | 340 ms   | 831 ms   | 1,919 ms  | under 1 s    | yes |
| Writes | 50    | 4,834 ms | 8,787 ms | 27,155 ms | about 15 s   | yes |

## Keeper sizing

How many goals a keeper pass collects with 1, 2 and 4 channel accounts is in [keeper-sizing.md](keeper-sizing.md).

## Load and stress test

How the contracts and the SDK behave as concurrent users ramp up on a local network, the breaking point, and the checks that everything recovers, are in [load-test.md](load-test.md).
