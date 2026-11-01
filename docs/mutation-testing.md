# Mutation testing

Mutation testing makes small changes to the source, one at a time, and runs the tests against each. A change the tests notice is caught. A change they don't notice survives, and shows either a gap in the tests or a change that makes no difference. It ran once before the stable release (T12) and is not part of CI.

## The run

- Tool: cargo-mutants 27.1.0.
- Commit: `51d654be45ce37a443e117b720f1171cb084b923`.
- Where: a scratch copy outside the repo, holding `contracts`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml` and the two release Wasm files in `target/wasm32v1-none/release/`.
- Command, after `stellar contract build`:

```sh
cargo mutants --copy-target=true --no-shuffle -j 4 --output <folder outside the repo>
```

`TMPDIR` pointed at a disk folder, because the work copies don't fit in a small `/tmp`. The run stopped partway when its session ended, so it was resumed with `--iterate` and the same output folder. It took about 4 hours 55 minutes of running time in those two parts.

## Totals

439 mutants, from the commit above, before the tests below were added. 431 come from the contract code, and the other 8 from `contracts/common/src/budgets.rs`, which only the resource tests compile.

| Crate                   | Mutants | Caught | Missed | Timeout | Unviable |
| ----------------------- | ------- | ------ | ------ | ------- | -------- |
| `loktin-common`         | 175     | 156    | 18     | 0       | 1        |
| `loktin-spend-save`     | 145     | 124    | 4      | 0       | 17       |
| `loktin-target-savings` | 119     | 105    | 0      | 0       | 14       |
| Total                   | 439     | 385    | 22     | 0       | 32       |

An unviable mutant doesn't compile, so it tests nothing.

## Survivors

None of the 22 showed a bug in a contract. 19 are now caught, and 3 don't change behaviour.

### Now caught by a new test

Rerun with the new tests in place, these are all caught.

| Mutant, in `contracts/common/src/calendar.rs`     | Test that catches it, in `contracts/common/tests/calendar.rs` |
| ------------------------------------------------- | ------------------------------------------------------------- |
| 129:14 match guard `is_leap_year(year)` to `true` | `next_window_across_common_february`                          |
| 130:9 delete match arm `2` in `days_in_month`     | `next_window_across_common_february`                          |
| 131:9 delete match arm `4 \| 6 \| 9 \| 11`        | `next_window_across_30_day_month`                             |
| 137:5 `is_leap_year` to `true`                    | `next_window_across_common_february`                          |
| 137:19 `&&` to `\|\|` in `is_leap_year`           | `next_window_across_common_february`                          |
| 137:28 `%` to `/` in `year % 100`                 | `next_window_across_century_februaries`                       |
| 137:28 `%` to `+` in `year % 100`                 | `next_window_across_century_februaries`                       |
| 137:47 `%` to `/` in `year % 400`                 | `next_window_across_century_februaries`                       |
| 137:47 `%` to `+` in `year % 400`                 | `next_window_across_century_februaries`                       |
| 137:53 `==` to `!=` in `is_leap_year`             | `next_window_across_century_februaries`                       |

| Mutant                                                                   | Test that catches it                                                                         |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `contracts/spend-save/src/lib.rs` 321:30 `>` to `>=` in `save_for_spend` | `skim_trimmed_to_nothing_moves_no_tokens`, in `contracts/spend-save/tests/save_for_spend.rs` |
| `contracts/common/src/budgets.rs` 69:38 `/` to `*` in `line`             | `a_figure_on_the_line_fails`, in `contracts/target-savings/tests/budgets.rs`                 |
| `contracts/common/src/budgets.rs` 69:11 `*` to `+` in `line`             | `a_figure_on_the_line_fails`, in `contracts/target-savings/tests/budgets.rs`                 |
| `contracts/common/src/budgets.rs` 75:5 `check` to `()`                   | `a_figure_on_the_line_fails`, in `contracts/target-savings/tests/budgets.rs`                 |

### Caught by another crate's tests

`common` has no tests of its own for `budgets.rs`: the feature that compiles it is only on for the contracts' tests. These five were caught on the original commit with `--test-workspace=true -f contracts/common/src/budgets.rs`, by the contracts' `budgets` tests.

| Mutant, in `contracts/common/src/budgets.rs` |
| -------------------------------------------- |
| 69:5 `line` to `0`                           |
| 69:5 `line` to `1`                           |
| 69:5 `line` to `-1`                          |
| 69:11 `*` to `/` in `line`                   |
| 69:38 `/` to `%` in `line`                   |

With that flag, each mutant runs the whole workspace but the baseline still runs only the mutated package, so the automatic timeout is far too short: pass `--timeout` as well.

### Don't change behaviour

| Mutant, in `contracts/spend-save/src/lib.rs`      | Why it makes no difference                                                                                                                                                                                                                                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 362:31 `>` to `>=` in `withdraw`                  | `to_user` is never 0 here: the amount is at least 1, and the two fees are each at most 1%, rounded down.                                                                                                                                                                                              |
| 735:38 first `\|\|` to `&&` in `deposit_to_goal`  | A goal with another owner, or past its deadline, now reaches `try_deposit`, where Target Savings refuses it (`NotOwner`, `DeadlinePassed`), and any refusal gives the same `(0, None)`, so only the call's cost changes.                                                                              |
| 735:80 second `\|\|` to `&&` in `deposit_to_goal` | A goal past its deadline with room left now reaches `try_deposit`, where Target Savings refuses it (`DeadlinePassed`). A full goal within its deadline reaches it with an amount of 0, and is refused with `InvalidDeposit`. Any refusal gives the same `(0, None)`, so only the call's cost changes. |

## The limit

`upgrade`, `storage_compat` and `budgets` read the release Wasm, which is not rebuilt for each mutant, so those tests never see a mutation in the contract code; the other tests use the native contract and do.
