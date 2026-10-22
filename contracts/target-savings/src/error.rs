//! Contract error codes (S7). Codes are documented in `docs/errors.md`.

use loktin_common::CommonError;
use soroban_sdk::contracterror;

/// Errors returned by the Target Savings contract.
///
/// Codes 1 to 5 mirror [`CommonError`] exactly. Codes 100 to 199 belong to
/// Target Savings. OpenZeppelin's pausable (1000 to 1001) and access control
/// (2000 to 2010) errors come from that library.
#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// An amount is negative.
    InvalidAmount = 1,
    /// A calculation overflowed.
    Overflow = 2,
    /// A rate is above its cap.
    RateAboveCap = 3,
    /// A day of the month is outside 1 to 28.
    InvalidDay = 4,
    /// A cadence is zero.
    InvalidCadence = 5,
    /// No open goal has this id.
    GoalNotFound = 100,
    /// The caller does not own the goal.
    NotOwner = 101,
    /// The target is not above zero.
    InvalidTarget = 102,
    /// The deposit size or deposit amount is not above zero.
    InvalidDeposit = 103,
    /// The deadline is not after the current ledger time.
    InvalidDeadline = 104,
    /// The cadence is below the instance's minimum cadence.
    CadenceTooShort = 105,
    /// The first period would fall due after the deadline.
    NoPeriodBeforeDeadline = 106,
    /// The owner already has the maximum number of open goals.
    TooManyGoals = 107,
    /// No period has started yet.
    NotDue = 108,
    /// The current period has already been collected.
    AlreadyCollected = 109,
    /// The deadline has passed.
    DeadlinePassed = 110,
    /// The goal has already reached its target.
    TargetReached = 111,
    /// The owner's balance or the contract's allowance is below the amount due.
    Shortfall = 112,
    /// The deposit is above what the goal still needs.
    ExceedsTarget = 113,
    /// The lock rule forbids withdrawal before the target or deadline.
    Locked = 114,
    /// A page limit is outside 1 to 50.
    InvalidLimit = 115,
    /// A yield source was supplied, and none is supported in this version.
    YieldSourceNotSupported = 116,
    /// The contract's configuration is missing from storage.
    ConfigMissing = 117,
    /// The integrator is this contract.
    InvalidIntegrator = 118,
    /// The fee recipient is this contract.
    InvalidFeeRecipient = 119,
}

impl From<CommonError> for Error {
    fn from(error: CommonError) -> Self {
        match error {
            CommonError::InvalidAmount => Error::InvalidAmount,
            CommonError::Overflow => Error::Overflow,
            CommonError::RateAboveCap => Error::RateAboveCap,
            CommonError::InvalidDay => Error::InvalidDay,
            CommonError::InvalidCadence => Error::InvalidCadence,
        }
    }
}
