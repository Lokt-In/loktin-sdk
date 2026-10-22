//! Errors returned by the shared helpers.

/// An error from a shared helper.
///
/// This is a plain Rust enum, not a contract error type. Each contract maps a
/// variant to its own error type using the code documented on the variant.
/// The codes sit in the shared range 1 to 99 and are listed in
/// `docs/errors.md`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum CommonError {
    /// Contract error code 1: an amount is negative.
    InvalidAmount = 1,
    /// Contract error code 2: a calculation overflowed.
    Overflow = 2,
    /// Contract error code 3: a rate is above its cap.
    RateAboveCap = 3,
    /// Contract error code 4: a day of the month is outside 1 to 28.
    InvalidDay = 4,
    /// Contract error code 5: a cadence is zero.
    InvalidCadence = 5,
}

impl CommonError {
    /// The contract error code this variant maps to.
    #[must_use]
    pub const fn code(self) -> u32 {
        self as u32
    }
}
