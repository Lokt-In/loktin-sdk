//! Fee and penalty arithmetic (R2, R4, P4, C9).

use crate::CommonError;

/// Basis points in one whole.
pub const BPS_DENOMINATOR: u32 = 10_000;

/// Highest Loktin fee rate, 1% (R4).
pub const MAX_LOKTIN_FEE_BPS: u32 = 100;

/// Highest integrator fee rate, 1% (R4).
pub const MAX_INTEGRATOR_FEE_BPS: u32 = 100;

/// Highest early-withdrawal penalty rate, 10% (P4).
pub const MAX_PENALTY_BPS: u32 = 1_000;

/// How a withdrawal of a principal splits between its recipients.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Breakdown {
    /// Early-withdrawal penalty, paid to the integrator's penalty address.
    pub penalty: i128,
    /// Loktin fee, paid to the Loktin fee recipient.
    pub loktin_fee: i128,
    /// Integrator fee, paid to the integrator's fee address.
    pub integrator_fee: i128,
    /// What the user receives.
    pub to_user: i128,
}

/// Returns `floor(amount * bps / 10_000)`.
///
/// # Errors
///
/// - [`CommonError::InvalidAmount`] if `amount` is negative.
/// - [`CommonError::RateAboveCap`] if `bps` is above 10,000.
/// - [`CommonError::Overflow`] if `amount * bps` does not fit in an `i128`.
pub fn bps_of(amount: i128, bps: u32) -> Result<i128, CommonError> {
    if amount < 0 {
        return Err(CommonError::InvalidAmount);
    }
    if bps > BPS_DENOMINATOR {
        return Err(CommonError::RateAboveCap);
    }
    let product = amount
        .checked_mul(i128::from(bps))
        .ok_or(CommonError::Overflow)?;
    // Both operands are non-negative, so truncating division rounds down.
    product
        .checked_div(i128::from(BPS_DENOMINATOR))
        .ok_or(CommonError::Overflow)
}

/// Splits a withdrawn principal into penalty, fees and the user's share.
///
/// Each deduction is calculated on the principal and rounded down, so any
/// fraction stays with the user (R2, C9).
///
/// # Errors
///
/// - [`CommonError::RateAboveCap`] if any rate is above its cap.
/// - [`CommonError::InvalidAmount`] if `principal` is negative.
/// - [`CommonError::Overflow`] if a calculation does not fit in an `i128`.
pub fn withdrawal_breakdown(
    principal: i128,
    penalty_bps: u32,
    loktin_fee_bps: u32,
    integrator_fee_bps: u32,
) -> Result<Breakdown, CommonError> {
    if penalty_bps > MAX_PENALTY_BPS
        || loktin_fee_bps > MAX_LOKTIN_FEE_BPS
        || integrator_fee_bps > MAX_INTEGRATOR_FEE_BPS
    {
        return Err(CommonError::RateAboveCap);
    }
    let penalty = bps_of(principal, penalty_bps)?;
    let loktin_fee = bps_of(principal, loktin_fee_bps)?;
    let integrator_fee = bps_of(principal, integrator_fee_bps)?;
    let to_user = principal
        .checked_sub(penalty)
        .and_then(|rest| rest.checked_sub(loktin_fee))
        .and_then(|rest| rest.checked_sub(integrator_fee))
        .ok_or(CommonError::Overflow)?;
    Ok(Breakdown {
        penalty,
        loktin_fee,
        integrator_fee,
        to_user,
    })
}
