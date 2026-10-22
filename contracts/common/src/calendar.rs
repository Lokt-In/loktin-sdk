//! UTC calendar helpers based on ledger timestamps (P13, P16, S8).
//!
//! Timestamps are seconds since 1970-01-01 00:00:00 UTC, as read from the
//! ledger close time. Every window is half-open: it starts at `start` and
//! ends just before `end`.

use crate::CommonError;

const SECONDS_PER_DAY: u64 = 86_400;

/// Lowest withdrawal day of the month (P16).
pub const MIN_DAY: u32 = 1;

/// Highest withdrawal day of the month (P16).
pub const MAX_DAY: u32 = 28;

/// Converts a count of days since 1970-01-01 into a `(year, month, day)`
/// civil date in the proleptic Gregorian calendar.
///
/// This is Howard Hinnant's `civil_from_days` algorithm, from
/// "chrono-Compatible Low-Level Date Algorithms"
/// (<https://howardhinnant.github.io/date_algorithms.html#civil_from_days>).
///
/// # Errors
///
/// [`CommonError::Overflow`] if `days` is too close to the limits of `i64`.
pub fn civil_from_days(days: i64) -> Result<(i64, u32, u32), CommonError> {
    // Shift the epoch to 0000-03-01, so leap days fall at the end of a year.
    let z = days.checked_add(719_468).ok_or(CommonError::Overflow)?;
    let era = if z >= 0 {
        z
    } else {
        z.checked_sub(146_096).ok_or(CommonError::Overflow)?
    } / 146_097;
    // Day of era, in [0, 146096].
    let doe = z - era * 146_097;
    // Year of era, in [0, 399].
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    // Day of year counted from 1 March, in [0, 365].
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    // Month counted from March, in [0, 11].
    let mp = (5 * doy + 2) / 153;
    // Both fit in u32: day is in [1, 31] and month is in [1, 12].
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    Ok((year, month, day))
}

/// Returns the UTC `(year, month, day)` of a timestamp.
///
/// # Errors
///
/// Never fails for a `u64` timestamp. The `Result` passes on the checked
/// arithmetic of [`civil_from_days`].
pub fn utc_date(ts: u64) -> Result<(i64, u32, u32), CommonError> {
    let days = i64::try_from(ts / SECONDS_PER_DAY).map_err(|_| CommonError::Overflow)?;
    civil_from_days(days)
}

/// Returns `year * 12 + (month - 1)` for the UTC date of a timestamp.
///
/// # Errors
///
/// [`CommonError::Overflow`] if the result does not fit in a `u32`.
pub fn month_index(ts: u64) -> Result<u32, CommonError> {
    let (year, month, _) = utc_date(ts)?;
    u32::try_from(year)
        .ok()
        .and_then(|y| y.checked_mul(12))
        .and_then(|m| m.checked_add(month - 1))
        .ok_or(CommonError::Overflow)
}

/// Returns true when the UTC day of the month of `ts` equals `day` (P16).
///
/// # Errors
///
/// [`CommonError::InvalidDay`] if `day` is outside 1 to 28.
pub fn in_window(ts: u64, day: u32) -> Result<bool, CommonError> {
    check_day(day)?;
    let (_, _, today) = utc_date(ts)?;
    Ok(today == day)
}

/// Returns the `(start, end)` timestamps of the current window if `ts` is
/// inside one, otherwise of the next window.
///
/// `start` is 00:00:00 UTC on the withdrawal day, and `end` is 00:00:00 UTC
/// on the following day, the first second after the window.
///
/// # Errors
///
/// - [`CommonError::InvalidDay`] if `day` is outside 1 to 28.
/// - [`CommonError::Overflow`] if the window lies beyond the `u64` range.
pub fn next_window(ts: u64, day: u32) -> Result<(u64, u64), CommonError> {
    check_day(day)?;
    let (year, month, today) = utc_date(ts)?;
    let days_ahead = if today <= day {
        day - today
    } else {
        days_in_month(year, month) - today + day
    };
    let start = (ts - ts % SECONDS_PER_DAY)
        .checked_add(u64::from(days_ahead) * SECONDS_PER_DAY)
        .ok_or(CommonError::Overflow)?;
    let end = start
        .checked_add(SECONDS_PER_DAY)
        .ok_or(CommonError::Overflow)?;
    Ok((start, end))
}

fn check_day(day: u32) -> Result<(), CommonError> {
    if (MIN_DAY..=MAX_DAY).contains(&day) {
        Ok(())
    } else {
        Err(CommonError::InvalidDay)
    }
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        2 if is_leap_year(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn is_leap_year(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}
