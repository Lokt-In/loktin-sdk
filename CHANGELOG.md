# Changelog

## Unreleased

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
