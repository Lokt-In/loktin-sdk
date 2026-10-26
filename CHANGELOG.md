# Changelog

## Unreleased

## @loktin/sdk 0.3.0

- Breaking: `nextId` and `openGoals` are removed from the Target Savings module and its read adapter. Goal ids are no longer sequential.
- Find goals with `userGoals(owner)` for your own users, or from the `goal_created` and `goal_closed` events.

## contracts 0.3.0

Target Savings gives each goal an id derived from its owner and the owner's own goal counter, so goal creations by different users in the same ledger no longer conflict. `next_id` and `open_goals` are removed, and the new error `GoalIdUnavailable` (121) is added. Spend & Save changes only its version (decision 0003).

## @loktin/sdk 0.2.0

- `accruedFees` and `claimFees` in both modules: an integrator or Loktin's fee recipient reads and claims the fees owed to it.
- Withdrawals in both contracts now pay only the user. The penalty and fees accrue to their recipients, who claim them.

## contracts 0.2.0

The fees and penalty of a withdrawal accrue in the contract for their recipients to claim with `claim_fees`, so a recipient that cannot receive the token no longer blocks a user's withdrawal. Both contracts were upgraded in place on testnet on 2026-10-26 as the `contracts-v0.2.0` tag (decision 0002).

## @loktin/sdk 0.1.0

The first preview of the SDK, for Stellar testnet only.

- Core: `createLoktin` checks its options before any network call, reads with one RPC call each, and writes by building, simulating, signing with the user's wallet, sending and confirming one transaction.
- Errors: every error has a stable code, and contract errors are reported against the contract that raised them.
- Target Savings module: goals, deposits, scheduled collections, withdrawals, allowance renewal and every read.
- Spend & Save module: enrolment, settings, pay and save, save for a spend, withdrawals, closing, and every read.
- Helpers: amount conversion, the allowance for scheduled deposits, the worst-case withdrawal split, the effective withdrawal day, and withdrawal windows in local time.
- A read adapter can serve any read from somewhere other than the chain.

## contracts 0.1.0

The Target Savings and Spend & Save contracts, released on 2026-10-22 as the `contracts-v0.1.0` tag and deployed to testnet.
