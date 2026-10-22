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
| `upgraded`          | none               | `new_wasm_hash`, `operator`                                                                                            |

Notes:

- `missed` comes just before the `deposited` of the collection that recorded the missed periods.
- `withdrawn` is followed by `goal_closed` in the same call.
- `upgraded` is emitted by the upgrade call before the new code takes over. OpenZeppelin's upgrade function emits no event of its own.

## OpenZeppelin events

The contract also emits the events of the OpenZeppelin Stellar contracts library, version 0.8.0, unchanged:

- pausable: `paused` and `unpaused`, with no fields;
- access control: `role_granted`, `role_revoked`, `role_admin_changed`, `admin_transfer_initiated`, `admin_transfer_completed` and `admin_renounced`.
