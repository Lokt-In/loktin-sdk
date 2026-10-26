# End-to-end tests

The end-to-end tests run the built SDK against freshly deployed contracts on a private Stellar network on your machine (T8). They run on every pull request in CI, and you can run them locally.

## What they cover

The tests start a local network, create throwaway accounts, issue a test token called `TEST`, and deploy both contracts from the Wasm you just built, with a 60-second minimum cadence and a 1% Loktin fee. Then they call the contracts through the SDK, signing with the throwaway keys:

- **Target Savings:** creating a goal with the automatic allowance, a deposit, the `ExceedsTarget` and `NotDue` refusals, a real scheduled collection once the first 60-second period is due, `AlreadyCollected`, the withdrawal preview, the allowance status and an allowance renewal.
- **Spend & Save:** enrolling with a goal as the destination, a skim preview, `payAndSave` to a plain and to a muxed address, moving the destination to the balance, `saveForSpend`, the enrolment with its effective withdrawal day, the withdrawal window, a withdrawal, and closing the empty enrolment.
- **Accrued fees:** an integrator with no trustline for the token cannot block withdrawals. Its fees accrue, its claim fails with `TOKEN_ERROR` 13 until it adds a trustline, then the claim pays out once and a second claim gives `NothingToClaim`.
- **Error origin:** when the destination goal is closed, a payment to an account with no trustline is reported as the token's `TOKEN_ERROR` 13, not as `GoalNotFound`, and a skim aimed at the closed goal goes to the balance instead.
- **Pause:** while Target Savings is paused, a new goal is refused with `EnforcedPause`, and a withdrawal and a fee claim still work.

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

A run takes about two and a half minutes, most of it waiting for the first collection period.

`npm test` runs only the unit tests, never these.

## The UTC-day rule

Ledger time on a real network follows the clock and cannot be moved. A Spend & Save withdrawal window is a whole UTC day, and withdrawal days run from 1 to 28. So the tests that need an open window (the window itself, the Spend & Save withdrawal, closing the enrolment, and the Spend & Save fee accrual and claim) run only when the current UTC day is 1 to 28. On days 29 to 31 they are skipped, and the run logs why.

## Keys

Every key the tests use is a throwaway on the private local network. The keys are created in a temporary Stellar CLI config folder outside the repo, never in your own Stellar keystore, and the folder is deleted when the run ends. No secret is printed. Nothing touches testnet.
