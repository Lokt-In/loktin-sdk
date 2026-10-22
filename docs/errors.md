# Error codes

Contract error codes are stable, documented and never reused (S7).

## Shared codes

Codes 1 to 99 are shared by every contract and come from the helpers in `contracts/common`.

| Code | Name             | Meaning                                |
| ---- | ---------------- | -------------------------------------- |
| 1    | `InvalidAmount`  | An amount is negative.                 |
| 2    | `Overflow`       | A calculation overflowed.              |
| 3    | `RateAboveCap`   | A rate is above its cap.               |
| 4    | `InvalidDay`     | A day of the month is outside 1 to 28. |
| 5    | `InvalidCadence` | A cadence is zero.                     |

## Target Savings codes

Codes 100 to 199 belong to the Target Savings contract. It also returns the shared codes above.

| Code | Name                      | Meaning                                                              |
| ---- | ------------------------- | -------------------------------------------------------------------- |
| 100  | `GoalNotFound`            | No open goal has this id.                                            |
| 101  | `NotOwner`                | The caller does not own the goal.                                    |
| 102  | `InvalidTarget`           | The target is not above zero.                                        |
| 103  | `InvalidDeposit`          | The deposit size or deposit amount is not above zero.                |
| 104  | `InvalidDeadline`         | The deadline is not after the current ledger time.                   |
| 105  | `CadenceTooShort`         | The cadence is below the instance's minimum cadence.                 |
| 106  | `NoPeriodBeforeDeadline`  | The first period would fall due after the deadline.                  |
| 107  | `TooManyGoals`            | The owner already has 20 open goals.                                 |
| 108  | `NotDue`                  | No period has started yet.                                           |
| 109  | `AlreadyCollected`        | The current period has already been collected.                       |
| 110  | `DeadlinePassed`          | The deadline has passed.                                             |
| 111  | `TargetReached`           | The goal has already reached its target.                             |
| 112  | `Shortfall`               | The owner's balance or the contract's allowance is below the amount. |
| 113  | `ExceedsTarget`           | The deposit is above what the goal still needs.                      |
| 114  | `Locked`                  | The lock rule forbids withdrawal before the target or deadline.      |
| 115  | `InvalidLimit`            | A page limit is outside 1 to 50.                                     |
| 116  | `YieldSourceNotSupported` | A yield source was supplied, and none is supported in this version.  |
| 117  | `ConfigMissing`           | The contract's configuration is missing from storage.                |
| 118  | `InvalidIntegrator`       | The integrator is this contract.                                     |
| 119  | `InvalidFeeRecipient`     | The fee recipient is this contract.                                  |

## Spend & Save codes

Codes 200 to 299 belong to the Spend & Save contract. It also returns the shared codes above, and returns `InvalidAmount` (1) for an amount or spend of zero as well as a negative one.

| Code | Name                      | Meaning                                                                                                |
| ---- | ------------------------- | ------------------------------------------------------------------------------------------------------ |
| 200  | `EnrollmentNotFound`      | The user has no enrolment with this integrator.                                                        |
| 201  | `AlreadyEnrolled`         | The user is already enrolled with this integrator.                                                     |
| 202  | `TooManyEnrollments`      | The user already has 5 enrolments.                                                                     |
| 203  | `InvalidSkim`             | Neither skim part is set, the percentage is outside 1% to 50%, or the round-up unit is not above zero. |
| 204  | `InvalidCap`              | The monthly cap is not above zero.                                                                     |
| 205  | `DestinationUnavailable`  | A goal destination was chosen, and this instance has no Target Savings contract.                       |
| 206  | `OutsideWindow`           | The current UTC day is not the withdrawal day.                                                         |
| 207  | `ExceedsBalance`          | The amount is above the Spend & Save balance.                                                          |
| 208  | `BalanceNotZero`          | The enrolment still holds a balance.                                                                   |
| 209  | `InvalidIntegrator`       | The integrator is this contract.                                                                       |
| 210  | `InvalidFeeRecipient`     | The fee recipient is this contract.                                                                    |
| 211  | `InvalidPayee`            | The payee is this contract.                                                                            |
| 212  | `PaymentShortfall`        | The user's balance is below the payment.                                                               |
| 213  | `YieldSourceNotSupported` | A yield source was supplied, and none is supported in this version.                                    |
| 214  | `ConfigMissing`           | The contract's configuration is missing from storage.                                                  |

## OpenZeppelin codes

These come from the OpenZeppelin Stellar contracts library, version 0.8.0.

| Code         | Source         | Example                                                   |
| ------------ | -------------- | --------------------------------------------------------- |
| 1000         | Pausable       | `EnforcedPause`: the call is blocked while paused.        |
| 1001         | Pausable       | `ExpectedPause`: unpause was called while not paused.     |
| 2000 to 2010 | Access control | `Unauthorized` (2000): the caller does not hold the role. |
