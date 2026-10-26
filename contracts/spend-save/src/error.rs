//! Contract error codes (S7). Codes are documented in `docs/errors.md`.

use loktin_common::CommonError;
use soroban_sdk::contracterror;

/// Errors returned by the Spend & Save contract.
///
/// Codes 1 to 5 mirror [`CommonError`] exactly. Codes 200 to 299 belong to
/// Spend & Save. OpenZeppelin's pausable (1000 to 1001) and access control
/// (2000 to 2010) errors come from that library.
#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// An amount is not above zero.
    InvalidAmount = 1,
    /// A calculation overflowed.
    Overflow = 2,
    /// A rate is above its cap.
    RateAboveCap = 3,
    /// A day of the month is outside 1 to 28.
    InvalidDay = 4,
    /// A cadence is zero.
    InvalidCadence = 5,
    /// The user has no enrolment with this integrator.
    EnrollmentNotFound = 200,
    /// The user is already enrolled with this integrator.
    AlreadyEnrolled = 201,
    /// The user already has the maximum number of enrolments.
    TooManyEnrollments = 202,
    /// Neither skim part is set, the percentage is outside 1% to 50%, or the
    /// round-up unit is not above zero.
    InvalidSkim = 203,
    /// The monthly cap is not above zero.
    InvalidCap = 204,
    /// A goal destination was chosen, and this instance has no Target
    /// Savings contract.
    DestinationUnavailable = 205,
    /// The current UTC day is not the withdrawal day.
    OutsideWindow = 206,
    /// The amount is above the Spend & Save balance.
    ExceedsBalance = 207,
    /// The enrolment still holds a balance.
    BalanceNotZero = 208,
    /// The integrator is this contract.
    InvalidIntegrator = 209,
    /// The fee recipient is this contract.
    InvalidFeeRecipient = 210,
    /// The payee is this contract.
    InvalidPayee = 211,
    /// The user's balance is below the payment.
    PaymentShortfall = 212,
    /// A yield source was supplied, and none is supported in this version.
    YieldSourceNotSupported = 213,
    /// The contract's configuration is missing from storage.
    ConfigMissing = 214,
    /// The recipient has no accrued fees to claim.
    NothingToClaim = 215,
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
