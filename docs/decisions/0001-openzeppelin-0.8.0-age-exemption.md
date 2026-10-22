# 0001: OpenZeppelin 0.8.0 exemption from the 7-day rule

## Context

Every locked crate must be at least 7 days old (section 2.2). The plan (C6) requires OpenZeppelin stellar-contracts 0.8.0, the audited release whose crates require soroban-sdk 28.0.0. These crates were published on 2026-10-20, less than 7 days before the Target Savings contract was built:

- `stellar-access` 0.8.0
- `stellar-contract-utils` 0.8.0
- `stellar-macros` 0.8.0

## Decision

These three crates, at exactly version 0.8.0, are exempt from the 7-day rule. The exemption rests on these facts:

- They were published on 2026-10-20 by brozorec, an owner of all three crates on crates.io and the second-largest contributor to `OpenZeppelin/stellar-contracts`.
- An audit report for v0.8.0 is in that repo's `audits` folder.
- The plan (C6) requires them.

The exemption covers only these three crates at exactly 0.8.0. Any other version, and any other crate, follows the 7-day rule.

## Consequences

- The three crates are pinned exactly (`=0.8.0`) in `contracts/target-savings/Cargo.toml`.
- A move to a later OpenZeppelin release needs either the 7-day wait or a new decision.
- Every other newly locked crate is still checked for age at each review.
