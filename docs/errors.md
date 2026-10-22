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
