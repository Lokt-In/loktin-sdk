# Load and stress test

How the contracts and the SDK behave as more users write at the same time, where they stop coping, and whether everything is still consistent afterwards (T10, W70, W71).

## What it does and where it runs

The test runs on a private local Stellar network, started from the same pinned quickstart image as the end-to-end tests, with `--limits testnet` so each transaction has testnet's resource limits. It never runs on testnet: the public testnet RPC is rate limited, and a load test there would measure the rate limit, not the contracts. A guard refuses to run against any network but the local one.

It deploys its own pair of contracts (W78), so no other test shares its totals. Each user has their own account holding the test token, a Target Savings goal with a 60-second cadence, and a Spend & Save enrolment that saves 10% of each payment to its balance. Each user is a separate SDK instance.

## Phases

The steps are the numbers of users writing at the same time, by default 10, 25, 50, 100, 200, 400 and 800. Each step adds the users it needs to the last step's and runs 3 rounds with all of them at once. In each round a user makes a deposit into their goal, a payment with `payAndSave`, and a read of their goal.

- **Load:** the first four steps, 10 to 100 users.
- **Stress:** the steps after them, past normal levels. During each stress step a keeper pass with 4 channel accounts runs at the same time as the users, collecting the goals that are due.

For each step the test records the users, the writes sent, the success rate, the p50, p95 and longest time from the call to the confirmed result, the TRY_AGAIN_LATER answers, the transactions per ledger (average and peak), and the errors by SDK error code. Failures that are the user's own, such as low funds, are counted separately and left out of the success rate. On stress steps it also records what the keeper collected, skipped and failed. If a stress step's keeper pass loses its event scan to network errors, the step records that as its keeper failure and the run goes on. Any other keeper error, and any failure in the catch-up pass after the load, still fails the run.

## The breaking point

The breaking point is the first step where the success rate falls below 95%, or the p95 confirmation time goes over 60 seconds, or the step takes more than 15 minutes. The test runs one more step past it if the time allows, then stops ramping. If no step breaks, the breaking point is above the top step.

These thresholds are our own judgments, as are the targets they come from (W70): no published standard for them was found.

## Recovery

After the last step, the test waits for the 300-second upper time bound of every SDK transaction to pass. Then it checks, and fails the run if any of these does not hold, whatever the load did:

- every transaction whose outcome was unknown has either landed or is gone, and none is still pending;
- each contract's token balance equals the balances it records, all goals' principals in Target Savings and all enrolments' balances in Spend & Save, plus the fees accrued to the integrator and to Loktin's fee recipient;
- one more keeper pass collects what is due, with no failure;
- no goal collected a period twice: for each goal, the scheduled `deposited` events equal its last collected period less its missed periods.

## Running it

By hand, from GitHub: start the `Load test` workflow. It also runs every Monday at 03:17 UTC. It builds the contracts and the SDK, runs the full set of steps on a local network in the runner, and keeps `load-test.json` as the run's artifact for 90 days. It needs no secret.

Locally, with Docker and the Stellar CLI 28.1.0:

```sh
stellar contract build
npm run build
LOAD_STEPS=10,25 npm run sizing:load
```

`LOAD_STEPS` takes any comma-separated list of steps. The results go to `load-test.json` in the folder `LOAD_OUTPUT` names, or in a new temporary folder whose path the script prints. They hold measured data only, never a key: the steps, the recovery checks, the machine's CPU count and memory, the SDK version and commit, and the date.

## Results

The first workflow run: run 41090874144, 2026-10-30, commit `51d654b`, SDK 0.5.0, a GitHub runner with 4 CPUs and 16 GB, 795 s.

| Users | Phase  | Writes sent | Success | p50 (ms) | p95 (ms) | Max (ms) | Transactions per ledger, average | Transactions per ledger, peak | Errors                      |
| ----- | ------ | ----------- | ------- | -------- | -------- | -------- | -------------------------------- | ----------------------------- | --------------------------- |
| 10    | load   | 60          | 100%    | 1,170    | 2,207    | 2,221    | 6                                | 10                            | none                        |
| 25    | load   | 150         | 100%    | 1,433    | 2,496    | 2,507    | 15                               | 25                            | none                        |
| 50    | load   | 300         | 100%    | 1,947    | 2,886    | 2,971    | 25                               | 50                            | none                        |
| 100   | load   | 600         | 100%    | 2,971    | 4,180    | 4,827    | 31.58                            | 100                           | none                        |
| 200   | stress | 1,200       | 88.8%   | 2,966    | 4,815    | 5,186    | 13.33                            | 80                            | `PENDING` 134               |
| 400   | stress | 2,400       | 77.5%   | 5,444    | 11,115   | 22,431   | 23.83                            | 75                            | `PENDING` 480, `NETWORK` 61 |

**The breaking point** was 200 users, with success at 88.8%, under the 95% rule. 400 users was the one step past it, so 800 did not run.

Every write that did not succeed was a `PENDING` or `NETWORK` result. There were no `TRY_AGAIN_LATER` results and no failures of the test's own. Reads failed only at 400 users, 9 of 1,191.

**The keeper** collected 100 goals at 200 users, with none failed. At 400 it collected 7, then stopped on one `PENDING` result. After the load stopped it caught up and collected all 400.

**Recovery:** of 614 pending hashes, 0 landed, 614 were gone and 0 were stuck. Token balances matched the recorded totals in both contracts. 400 goals were checked, and none was collected twice.

This is a private network on one runner, so it shows how the contracts and the SDK behave under load, and it is not a figure for the public network.
