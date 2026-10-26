# 0003: Goal ids per owner, and upgrading Target Savings in place

## Context

The multi-user end-to-end test (part 7c2) found that goal creations by different users conflict when they land in the same ledger. Five users created a goal at the same moment. One succeeded, and the other four failed on chain with "trying to access contract data key outside of the footprint".

Up to 0.2.0, `create_goal` read the shared `NextId` and saved the new goal under `Goal(next_id)`. Each transaction was simulated against the same `NextId`, so each footprint named the same goal key. In the ledger, the transactions ran one after another: the first took that id, and the others then tried to write `Goal(next_id + 1)` and later, which their footprints did not contain.

Stellar's documentation on contract interactions describes exactly this: a contract that derives a storage key from changing state can touch an entry that simulation never saw, and the call then traps. `create_goal` was the only write in either contract whose key depended on state read while it ran.

## Decision

A goal's id comes from its owner and the owner's own goal counter (W75).

- A new persistent entry, `DataKey::GoalsCreated(owner)`, counts the ids an owner has used. It starts at 0 and only grows, even when goals close, so an id is never reused.
- The id is the first 8 bytes, big-endian, of `sha256(the owner as XDR, then the counter as 8 big-endian bytes)`.
- If that id is 0, or a goal already exists under it, the counter moves on by one and the next id is tried, at most 8 times. After that, `create_goal` fails with `GoalIdUnavailable` (Target Savings 121). The counter is then stored one past the value that produced the chosen id.
- `create_goal` no longer reads or writes `NextId`, and the constructor no longer sets it.

Every key `create_goal` now reads or writes depends only on its arguments and on the owner's own entries: the owner's counter, the owner's goal list, the goal keys derived from them, the owner's token allowance, and the configuration. So simulation sees exactly the keys execution touches, and creations by different owners never share an entry. Creations by the same owner still conflict with each other, which is expected: one account sends one transaction at a time.

`next_id` and `open_goals` are removed, together with `MAX_PAGE`. With ids no longer sequential, paging by number has no meaning. Goals are found instead from the `goal_created` and `goal_closed` events, kept by whoever indexes them, and from `user_goals` for an integrator's own users (S5, E1). `InvalidLimit` (115) is no longer returned, and stays in the error list because codes are never reused. The `DataKey::NextId` case stays too, marked as no longer written, because the live instance still holds that entry.

## Why the upgrade is safe in place

- The shape of a goal's key does not change: it is still `Goal(u64)`, and goals keep their 0.1.0 form. Only the way a new id is chosen changes.
- The change adds new keys and writes none of the old ones. Enum cases are stored by name (soroban-sdk-macros 28.0.0), so adding `GoalsCreated` leaves every existing key's encoding unchanged.
- An upgrade only replaces the code, and never runs the constructor (OpenZeppelin stellar-contracts 0.8.0). `SCHEMA_VERSION` stays 1.
- No goal exists on testnet yet, so no live goal is affected.
- A storage-compatibility test proves it. It registers the released 0.2.0 Wasm, creates three goals with sequential ids 1, 2 and 3, deposits and collects, then upgrades to the new build with the upgrader. The old goals read back unchanged, collect and withdraw as before, new goals get owner ids that differ from the old ones, and `user_goals` lists both kinds. The 0.2.0 Wasm in the test fixtures is the release build, checked against the hash deployed on testnet. The 0.1.0 compatibility test still passes unchanged.

## Consequences

- Both contracts move to version 0.3.0 (`binver` 0.3.0), released as the tag `contracts-v0.3.0`. Spend & Save changes nothing else, so its upgrade swaps in identical code with the new version number.
- Goal ids are no longer 1, 2, 3 and so on. Apps must use the id that `create_goal` returns or that `goal_created` reports.
- The SDK drops `nextId` and `openGoals` in 0.3.0.
- A keeper or app that needs every goal reads the `goal_created` and `goal_closed` events into its own store, since public RPC keeps only about 7 days of events.
- On testnet the upgrader is a single key the owner holds, and the upgrade needs no multisig or waiting period. Mainnet still needs both (C5).
