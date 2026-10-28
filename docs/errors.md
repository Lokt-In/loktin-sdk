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

| Code | Name                      | Meaning                                                                                                                |
| ---- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 100  | `GoalNotFound`            | No open goal has this id.                                                                                              |
| 101  | `NotOwner`                | The caller does not own the goal.                                                                                      |
| 102  | `InvalidTarget`           | The target is not above zero.                                                                                          |
| 103  | `InvalidDeposit`          | The deposit size or deposit amount is not above zero.                                                                  |
| 104  | `InvalidDeadline`         | The deadline is not after the current ledger time.                                                                     |
| 105  | `CadenceTooShort`         | The cadence is below the instance's minimum cadence.                                                                   |
| 106  | `NoPeriodBeforeDeadline`  | The first period would fall due after the deadline.                                                                    |
| 107  | `TooManyGoals`            | The owner already has 20 open goals.                                                                                   |
| 108  | `NotDue`                  | No period has started yet.                                                                                             |
| 109  | `AlreadyCollected`        | The current period has already been collected.                                                                         |
| 110  | `DeadlinePassed`          | The deadline has passed.                                                                                               |
| 111  | `TargetReached`           | The goal has already reached its target.                                                                               |
| 112  | `Shortfall`               | The owner's balance or the contract's allowance is below the amount.                                                   |
| 113  | `ExceedsTarget`           | The deposit is above what the goal still needs.                                                                        |
| 114  | `Locked`                  | The lock rule forbids withdrawal before the target or deadline.                                                        |
| 115  | `InvalidLimit`            | A page limit is outside 1 to 50. No longer returned since 0.3.0, which removed `open_goals`. The code is never reused. |
| 116  | `YieldSourceNotSupported` | A yield source was supplied, and none is supported in this version.                                                    |
| 117  | `ConfigMissing`           | The contract's configuration is missing from storage.                                                                  |
| 118  | `InvalidIntegrator`       | The integrator is this contract.                                                                                       |
| 119  | `InvalidFeeRecipient`     | The fee recipient is this contract.                                                                                    |
| 120  | `NothingToClaim`          | The recipient has no accrued fees to claim.                                                                            |
| 121  | `GoalIdUnavailable`       | No free goal id was found for the owner within 8 tries.                                                                |

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
| 215  | `NothingToClaim`          | The recipient has no accrued fees to claim.                                                            |

## OpenZeppelin codes

These come from the OpenZeppelin Stellar contracts library, version 0.8.0.

| Code         | Source         | Example                                                                                          |
| ------------ | -------------- | ------------------------------------------------------------------------------------------------ |
| 1000         | Pausable       | `EnforcedPause`: the call is blocked while paused.                                               |
| 1001         | Pausable       | `ExpectedPause`: unpause was called while not paused.                                            |
| 2000 to 2010 | Access control | `Unauthorized` (2000): the caller does not hold the role.                                        |
| 2200         | Role transfer  | `NoPendingTransfer`: there is no pending admin transfer to accept or cancel.                     |
| 2201         | Role transfer  | `InvalidLiveUntilLedger`: the transfer's expiry ledger is in the past or beyond the maximum TTL. |
| 2202         | Role transfer  | `InvalidPendingAccount`: the account named to cancel is not the pending admin.                   |
| 2203         | Role transfer  | `TransferExpired`: the current ledger is past the transfer's expiry ledger.                      |

## Token codes

The token both contracts hold is a Stellar Asset Contract, such as USDC. When a token call inside our contract fails, the token returns one of these codes. They come from rs-soroban-env (`contract_error.rs`). Code 1 is reserved.

| Code | Name                         |
| ---- | ---------------------------- |
| 2    | `OperationNotSupported`      |
| 3    | `AlreadyInitialized`         |
| 4    | `Unauthorized`               |
| 5    | `Authentication`             |
| 6    | `AccountMissing`             |
| 7    | `AccountIsNotClassic`        |
| 8    | `NegativeAmount`             |
| 9    | `Allowance`                  |
| 10   | `Balance`                    |
| 11   | `BalanceDeauthorized`        |
| 12   | `Overflow`                   |
| 13   | `TrustlineMissing`           |
| 14   | `InsufficientAccountReserve` |
| 15   | `TooManyAccountSubentries`   |

Token codes 2 to 5 are the same numbers as our shared codes, so a code alone does not say which contract raised it.

## How the SDK reports errors

The SDK reports each error against the contract that raised it. It reads the failed call's diagnostic events. The last error event has the code that failed the call. The SDK then walks back while the event just before is an error event with the same code, and the event it stops on names the contract that raised the error. It does not take the first error event, because the host keeps the error events of inner calls that failed and were handled, such as Spend & Save's `try_goal` and `try_deposit` calls into Target Savings. A code from Target Savings or Spend & Save is a `CONTRACT_ERROR` with that contract's name for the code. A code from the token is a `TOKEN_ERROR` with the token's name for the code, even when the call was made to our contract. A code from any other contract is an `UNKNOWN_CONTRACT_ERROR`.
