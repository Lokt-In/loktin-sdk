# Events

Event names and fields are a public interface (S6). Each event's first topic is its name. The fields marked as topics follow it, and the remaining fields are the event data, as a map keyed by field name.

## Target Savings

| Event               | Topics             | Data                                                                                                                   |
| ------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `goal_created`      | `goal_id`, `owner` | `integrator`, `target`, `deadline`, `cadence`, `deposit_size`, `rule`, `start`, `loktin_fee_bps`, `integrator_fee_bps` |
| `deposited`         | `goal_id`, `owner` | `kind` (`Manual` or `Scheduled`), `amount`, `principal` (after the deposit)                                            |
| `missed`            | `goal_id`          | `periods` (newly recorded as missed), `missed_count` (total)                                                           |
| `withdrawn`         | `goal_id`, `owner` | `amount` (the whole principal), `penalty`, `loktin_fee`, `integrator_fee`, `to_user`                                   |
| `goal_closed`       | `goal_id`, `owner` | none                                                                                                                   |
| `loktin_fee_set`    | none               | `loktin_fee_bps` (for goals created from now on)                                                                       |
| `fee_recipient_set` | none               | `fee_recipient`                                                                                                        |
| `fees_claimed`      | `recipient`        | `amount` (every fee accrued to the recipient, now paid out)                                                            |
| `upgraded`          | none               | `new_wasm_hash`, `operator`                                                                                            |

Notes:

- `missed` comes just before the `deposited` of the collection that recorded the missed periods.
- `withdrawn` is followed by `goal_closed` in the same call. Its `penalty` and `integrator_fee` accrue to the goal's integrator, and its `loktin_fee` to the fee recipient. Only `to_user` is transferred. Each recipient is paid when it calls `claim_fees`, which emits `fees_claimed`.
- `upgraded` is emitted by the upgrade call before the new code takes over. OpenZeppelin's upgrade function emits no event of its own.

## Spend & Save

| Event               | Topics               | Data                                                                                                                          |
| ------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `enrolled`          | `user`, `integrator` | `integrator_fee_bps`, `loktin_fee_bps`, `skim`, `monthly_cap`, `destination`, `withdrawal_day`                                |
| `settings_updated`  | `user`, `integrator` | `skim`, `monthly_cap`, `destination`, `withdrawal_day` (in force now), `pending_day` (`None`, or `Pending(day, month_index)`) |
| `saved`             | `user`, `integrator` | `spent`, `skim`, `cap_trimmed`, `shortfall`, `to_balance`, `to_goal`, `goal_id`                                               |
| `paid`              | `user`, `integrator` | `to` (a plain or muxed address), `amount`                                                                                     |
| `withdrawn`         | `user`, `integrator` | `amount`, `loktin_fee`, `integrator_fee`, `to_user`                                                                           |
| `enrollment_closed` | `user`, `integrator` | none                                                                                                                          |
| `loktin_fee_set`    | none                 | `loktin_fee_bps` (for enrolments created from now on)                                                                         |
| `fee_recipient_set` | none                 | `fee_recipient`                                                                                                               |
| `fees_claimed`      | `recipient`          | `amount` (every fee accrued to the recipient, now paid out)                                                                   |
| `upgraded`          | none                 | `new_wasm_hash`, `operator`                                                                                                   |

The `saved` fields:

- `spent`: the spend the skim was worked out from;
- `skim`: the skim before any trimming, the percentage part plus the round-up part, and never more than `spent` (P12);
- `cap_trimmed`: how much the monthly cap trimmed off;
- `shortfall`: how much the wallet could not cover after the cap;
- `to_balance`: the amount saved to the Spend & Save balance;
- `to_goal`: the amount deposited into a Target Savings goal;
- `goal_id`: the goal that received `to_goal`, or `None` when `to_goal` is 0.

In `withdrawn`, only `to_user` is transferred. The `integrator_fee` accrues to the integrator and the `loktin_fee` to the fee recipient, and each is paid when the recipient calls `claim_fees`, which emits `fees_claimed`.

`skim` equals `cap_trimmed + shortfall + to_balance + to_goal`. A skim of zero moves nothing and `saved` is still emitted (P14). In `pay_and_save`, `paid` comes just before `saved`.

## OpenZeppelin events

Both contracts also emit the events of the OpenZeppelin Stellar contracts library, version 0.8.0, unchanged:

- pausable: `paused` and `unpaused`, with no fields;
- access control: `role_granted`, `role_revoked`, `role_admin_changed`, `admin_transfer_initiated`, `admin_transfer_completed` and `admin_renounced`.
