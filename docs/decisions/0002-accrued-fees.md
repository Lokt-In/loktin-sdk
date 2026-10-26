# 0002: Accrued fees, and upgrading the testnet contracts in place

## Context

On 2026-10-24, a probe on a private local network found that a withdrawal from either contract could be blocked by someone other than the user.

In version 0.1.0, `withdraw` pays three parties in one transaction: the user's share to the user, the penalty and integrator fee to the integrator, and the Loktin fee to the fee recipient. A Stellar account with no trustline for the token cannot receive it. When the integrator had no trustline, the whole withdrawal failed with token error 13 (`TrustlineMissing`), and the user could not take out their savings. After the integrator added a trustline, the same withdrawal succeeded.

So an integrator without a trustline, or one that removes it, could freeze its users' withdrawals. The fee-admin could do the same by setting a fee recipient that cannot receive the token.

The Rust tests missed this. `Address::generate` makes contract addresses, and a contract address holds a token balance without a trustline, so every payment in the tests succeeded.

## Decision

A withdrawal pays only the user (W63).

- `withdraw` transfers only the user's share. The penalty and the integrator fee are credited to the integrator, and the Loktin fee to the current fee recipient, as accrued fees. All state is written before the one transfer.
- Each recipient takes its fees with `claim_fees(recipient)`, which the recipient signs. It pays out everything accrued, removes the entry and emits `fees_claimed`. Pause does not block it. With nothing accrued, it fails with `NothingToClaim` (Target Savings 120, Spend & Save 215).
- `accrued_fees(recipient)` reads what is owed.
- Accrued fees are kept in persistent storage, one entry per recipient, under the new key `DataKey::AccruedFees`. A persistent entry that is not touched is archived, never deleted, and the next call that simulates it restores it. Temporary storage would lose the fees, so it is never used for them.
- The return values of `withdraw` and the `withdrawn` event are unchanged.

## Why the upgrade is safe in place

The live testnet contracts are upgraded with the upgrader key, so their addresses stay the same.

- A new storage key does not move the old ones. A `#[contracttype]` enum case is stored under its name, as a symbol, not under its position (soroban-sdk-macros 28.0.0). Adding `AccruedFees` leaves the encoding of every existing key unchanged.
- An upgrade only replaces the code. OpenZeppelin's `upgrade` (stellar-contracts 0.8.0) never runs the constructor, and the schema version in instance storage changes only when code sets it.
- No stored record changes in this version. Goals, enrolments and the configuration keep their 0.1.0 form, so `SCHEMA_VERSION` stays 1.
- A storage-compatibility test in each contract proves it. It registers the released 0.1.0 Wasm, creates real state with it, upgrades to the new build with the upgrader, and checks that every old record reads back unchanged, that a withdrawal now accrues the fees, and that `claim_fees` pays them. The 0.1.0 Wasm in the test fixtures is the release build, checked against the hash deployed on testnet.

## Consequences

- Both contracts move to version 0.2.0 (`binver` 0.2.0), released as the tag `contracts-v0.2.0`.
- Integrators and the fee recipient must call `claim_fees` to receive their fees. Until then the fees stay in the contract, and the contract's token balance equals open principals plus unclaimed fees.
- On testnet the upgrader is a single key the owner holds, and the upgrade needs no multisig or waiting period. Mainnet still needs both (C5).
