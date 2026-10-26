# End-to-end tests

The end-to-end tests run the built SDK against freshly deployed contracts on a private Stellar network on your machine (T8). They run on every pull request in CI, and you can run them locally.

## What they cover

The tests start a local network, create throwaway accounts, issue a test token called `TEST`, and deploy both contracts from the Wasm you just built, with a 60-second minimum cadence and a 1% Loktin fee. Then they call the contracts through the SDK, signing with the throwaway keys:

- **Target Savings:** creating a goal with the automatic allowance, a deposit, the `ExceedsTarget` and `NotDue` refusals, a real scheduled collection once the first 60-second period is due, `AlreadyCollected`, the withdrawal preview, the allowance status and an allowance renewal.
- **Spend & Save:** enrolling with a goal as the destination, a skim preview, `payAndSave` to a plain and to a muxed address, moving the destination to the balance, `saveForSpend`, the enrolment with its effective withdrawal day, the withdrawal window, a withdrawal, and closing the empty enrolment.
- **Accrued fees:** an integrator with no trustline for the token cannot block withdrawals. Its fees accrue, its claim fails with `TOKEN_ERROR` 13 until it adds a trustline, then the claim pays out once and a second claim gives `NothingToClaim`.
- **Error origin:** when the destination goal is closed, a payment to an account with no trustline is reported as the token's `TOKEN_ERROR` 13, not as `GoalNotFound`, and a skim aimed at the closed goal goes to the balance instead.
- **Pause:** while Target Savings is paused, a new goal is refused with `EnforcedPause`, and a withdrawal and a fee claim still work.
- **Goal creations in the same ledger:** ten users each create a goal at the same moment, and all ten succeed, some of them in the same ledger. Each goal's id comes from its owner and the owner's own counter, so creations by different users never touch the same entry.

### The multi-user scenario

`multi-user.e2e.test.ts` deploys its own pair of contracts, with the same settings as the other files, so state they leave behind cannot change its sums. It creates 10 users with a trustline each and two integrators. Nine users get plenty of `TEST`. The tenth gets just enough for one deposit, so its scheduled collections run short.

It then runs these steps:

- all ten users create their goals at the same time, six each, 60 in all, split between the two integrators, with penalty and lock rules and the automatic allowance;
- half the goals are collected in period 1 and the rest are left out on purpose; in period 2 every goal is collected, and the left-out goals record one missed period;
- the short user's collections fail with `Shortfall` and change nothing;
- some goals are withdrawn, early with a penalty or once they reach their target;
- every goal is found again: its id from the `goal_created` events since the scenario started, and every open goal from `userGoals` for each user;
- users enrol in Spend & Save, one with both integrators, save at the same time and withdraw;
- one user's deposit and withdrawal on another user's goal are refused with `NotOwner`, and a skim aimed at another user's goal goes to the sender's own balance.

Users act at the same time, and each user sends one transaction at a time. After every step the test checks that:

- each contract's token balance equals its open principals plus every recipient's unclaimed fees;
- each integrator's accrued fees are exactly the fees of its own goals and enrolments, and the fee recipient's are exactly the Loktin fees;
- only the users who acted have changed records;
- each goal collected in a period records that period, and a second collection in it is refused.

Goal ids are not sequential, so the test does not page through them by number. It finds goals the way an app or keeper does: from the contract's `goal_created` events, and from `userGoals` for the users it knows.

The file takes about three minutes, most of it waiting for the collection periods.

## What you need

- Docker. The network runs in the `stellar/quickstart` image, pinned by its digest in `scripts/e2e.sh`. The first run downloads it, which can take a few minutes.
- The Stellar CLI 28.1.0.
- Node.js 24 and the repo's dependencies (`npm ci`).

## How to run them

```sh
stellar contract build
npm run build
npm run test:e2e
```

`npm run test:e2e` runs `scripts/e2e.sh`. It starts the network on port 8000 (set `E2E_PORT` to use another), waits for it to be ready, runs the tests one file after another, and always removes the container at the end. If a test fails, it first prints the last 200 lines of the network's log.

A run takes about six minutes, most of it waiting for collection periods.

`npm test` runs only the unit tests, never these.

## The UTC-day rule

Ledger time on a real network follows the clock and cannot be moved. A Spend & Save withdrawal window is a whole UTC day, and withdrawal days run from 1 to 28. So the tests that need an open window (the window itself, the Spend & Save withdrawal, closing the enrolment, and the Spend & Save fee accrual and claim) run only when the current UTC day is 1 to 28. On days 29 to 31 they are skipped, and the run logs why.

## Keys

Every key the tests use is a throwaway on the private local network. The keys are created in a temporary Stellar CLI config folder outside the repo, never in your own Stellar keystore, and the folder is deleted when the run ends. No secret is printed. Nothing touches testnet.
