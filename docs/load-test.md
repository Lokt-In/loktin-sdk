# Load and stress test

How the contracts and the SDK behave as more users write at the same time, where they stop coping, and whether everything is still consistent afterwards (T10, W70, W71).

## What it does and where it runs

The test runs on a private local Stellar network, started from the same pinned quickstart image as the end-to-end tests, with `--limits testnet` so each transaction has testnet's resource limits. It never runs on testnet: the public testnet RPC is rate limited, and a load test there would measure the rate limit, not the contracts. A guard refuses to run against any network but the local one.

It deploys its own pair of contracts (W78), so no other test shares its totals. Each user has their own account holding the test token, a Target Savings goal with a 60-second cadence, and a Spend & Save enrolment that saves 10% of each payment to its balance. Each user is a separate SDK instance.

## Phases

The steps are the numbers of users writing at the same time, by default 10, 25, 50, 100, 200, 400 and 800. Each step adds the users it needs to the last step's and runs 3 rounds with all of them at once. In each round a user makes a deposit into their goal, a payment with `payAndSave`, and a read of their goal.

- **Load:** the first four steps, 10 to 100 users.
- **Stress:** the steps after them, past normal levels. During each stress step a keeper pass with 4 channel accounts runs at the same time as the users, collecting the goals that are due.

For each step the test records the users, the writes sent, the success rate, the p50, p95 and longest time from the call to the confirmed result, the TRY_AGAIN_LATER answers, the transactions per ledger (average and peak), and the errors by SDK error code. Failures that are the user's own, such as low funds, are counted separately and left out of the success rate. On stress steps it also records what the keeper collected, skipped and failed.

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

The first workflow run's numbers go here.
