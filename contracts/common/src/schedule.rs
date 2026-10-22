//! Scheduled deposit periods (P3 as amended, C3).
//!
//! Period `k` (k = 1, 2, ...) is due at `start + k * cadence` and lasts until
//! `start + (k + 1) * cadence`. No deposit is due at creation.

use crate::CommonError;

/// Returns the period current at `now`, or `None` before the first period.
///
/// # Errors
///
/// [`CommonError::InvalidCadence`] if `cadence` is 0.
pub fn current_period(start: u64, cadence: u64, now: u64) -> Result<Option<u64>, CommonError> {
    if cadence == 0 {
        return Err(CommonError::InvalidCadence);
    }
    let Some(elapsed) = now.checked_sub(start) else {
        return Ok(None);
    };
    let period = elapsed
        .checked_div(cadence)
        .ok_or(CommonError::InvalidCadence)?;
    Ok((period > 0).then_some(period))
}

/// Counts the whole periods that ended uncollected after
/// `last_collected_period` and before `current_period`.
///
/// Pass 0 as `last_collected_period` when no period has been collected yet.
/// The current period has not ended, so it is never counted.
#[must_use]
pub fn missed_between(last_collected_period: u64, current_period: u64) -> u64 {
    current_period
        .checked_sub(last_collected_period)
        .and_then(|gap| gap.checked_sub(1))
        .unwrap_or(0)
}
