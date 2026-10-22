use loktin_common::calendar::{
    civil_from_days, in_window, month_index, next_window, utc_date, MAX_DAY, MIN_DAY,
};
use loktin_common::CommonError;

const DAY: u64 = 86_400;

// Midnight UTC timestamps for known dates.
const T_1970_01_01: u64 = 0;
const T_2000_02_29: u64 = 951_782_400;
const T_2024_02_29: u64 = 1_709_164_800;
const T_2100_03_01: u64 = 4_107_542_400;
const T_2026_10_22: u64 = 1_792_627_200;
const T_2026_12_31_23_59_59: u64 = 1_798_761_599;

#[test]
fn civil_from_days_known_dates() {
    assert_eq!(civil_from_days(0), Ok((1970, 1, 1)));
    assert_eq!(civil_from_days(-1), Ok((1969, 12, 31)));
    assert_eq!(civil_from_days(11_016), Ok((2000, 2, 29)));
    assert_eq!(civil_from_days(19_782), Ok((2024, 2, 29)));
    assert_eq!(civil_from_days(47_541), Ok((2100, 3, 1)));
}

#[test]
fn civil_from_days_extremes_do_not_panic() {
    assert_eq!(civil_from_days(i64::MAX), Err(CommonError::Overflow));
    assert!(civil_from_days(i64::MIN).is_ok());
}

#[test]
fn utc_date_known_dates() {
    assert_eq!(utc_date(T_1970_01_01), Ok((1970, 1, 1)));
    assert_eq!(utc_date(T_2000_02_29), Ok((2000, 2, 29)));
    assert_eq!(utc_date(T_2024_02_29), Ok((2024, 2, 29)));
    assert_eq!(utc_date(T_2100_03_01), Ok((2100, 3, 1)));
    assert_eq!(utc_date(T_2026_10_22), Ok((2026, 10, 22)));
    assert_eq!(utc_date(T_2026_12_31_23_59_59), Ok((2026, 12, 31)));
    assert_eq!(utc_date(T_2026_12_31_23_59_59 + 1), Ok((2027, 1, 1)));
}

#[test]
fn utc_date_2100_is_not_a_leap_year() {
    // 2100-02-28 is followed directly by 2100-03-01.
    assert_eq!(utc_date(T_2100_03_01 - DAY), Ok((2100, 2, 28)));
}

#[test]
fn utc_date_max_timestamp_does_not_panic() {
    assert!(utc_date(u64::MAX).is_ok());
}

#[test]
fn month_index_known_dates() {
    assert_eq!(month_index(T_1970_01_01), Ok(1970 * 12));
    assert_eq!(month_index(T_2000_02_29), Ok(2000 * 12 + 1));
    assert_eq!(month_index(T_2026_10_22), Ok(2026 * 12 + 9));
    assert_eq!(month_index(T_2026_12_31_23_59_59), Ok(2026 * 12 + 11));
    assert_eq!(month_index(T_2026_12_31_23_59_59 + 1), Ok(2027 * 12));
}

#[test]
fn month_index_overflow_does_not_panic() {
    assert_eq!(month_index(u64::MAX), Err(CommonError::Overflow));
}

#[test]
fn day_bounds() {
    assert_eq!(MIN_DAY, 1);
    assert_eq!(MAX_DAY, 28);
    for ts in [T_1970_01_01, T_2026_10_22] {
        assert_eq!(in_window(ts, 0), Err(CommonError::InvalidDay));
        assert_eq!(in_window(ts, 29), Err(CommonError::InvalidDay));
        assert!(in_window(ts, 1).is_ok());
        assert!(in_window(ts, 28).is_ok());
        assert_eq!(next_window(ts, 0), Err(CommonError::InvalidDay));
        assert_eq!(next_window(ts, 29), Err(CommonError::InvalidDay));
        assert!(next_window(ts, 1).is_ok());
        assert!(next_window(ts, 28).is_ok());
    }
}

#[test]
fn in_window_known_dates() {
    assert_eq!(in_window(T_1970_01_01, 1), Ok(true));
    assert_eq!(in_window(T_1970_01_01, 2), Ok(false));
    assert_eq!(in_window(T_2026_10_22, 22), Ok(true));
    assert_eq!(in_window(T_2026_10_22, 21), Ok(false));
    assert_eq!(in_window(T_2026_10_22, 28), Ok(false));
    // The 29th, 30th and 31st are never a withdrawal day.
    for day in MIN_DAY..=MAX_DAY {
        assert_eq!(in_window(T_2026_12_31_23_59_59, day), Ok(false));
    }
}

#[test]
fn window_opens_at_midnight_and_closes_after_23_59_59() {
    let start = T_2026_10_22;
    assert_eq!(in_window(start - 1, 22), Ok(false));
    assert_eq!(in_window(start, 22), Ok(true));
    assert_eq!(in_window(start + DAY - 1, 22), Ok(true));
    assert_eq!(in_window(start + DAY, 22), Ok(false));
}

#[test]
fn next_window_inside_window_returns_current_window() {
    let expected = Ok((T_2026_10_22, T_2026_10_22 + DAY));
    assert_eq!(next_window(T_2026_10_22, 22), expected);
    assert_eq!(next_window(T_2026_10_22 + 12 * 3_600, 22), expected);
    assert_eq!(next_window(T_2026_10_22 + DAY - 1, 22), expected);
}

#[test]
fn next_window_later_this_month() {
    // 2026-10-28.
    let start = T_2026_10_22 + 6 * DAY;
    assert_eq!(next_window(T_2026_10_22, 28), Ok((start, start + DAY)));
}

#[test]
fn next_window_next_month() {
    // 2026-11-01 and 2026-11-21.
    let nov_1 = T_2026_10_22 + 10 * DAY;
    assert_eq!(next_window(T_2026_10_22, 1), Ok((nov_1, nov_1 + DAY)));
    let nov_21 = nov_1 + 20 * DAY;
    assert_eq!(next_window(T_2026_10_22, 21), Ok((nov_21, nov_21 + DAY)));
    // Just after a window closes, the next one is a month later.
    assert_eq!(
        next_window(T_2026_10_22 + DAY, 22),
        Ok((nov_21 + DAY, nov_21 + 2 * DAY))
    );
}

#[test]
fn next_window_across_year_end() {
    // 2027-01-01.
    let jan_1 = T_2026_12_31_23_59_59 + 1;
    assert_eq!(
        next_window(T_2026_12_31_23_59_59, 1),
        Ok((jan_1, jan_1 + DAY))
    );
}

#[test]
fn next_window_across_leap_february() {
    // From 2024-02-29 the next 28th is 2024-03-28.
    let mar_28 = T_2024_02_29 + 28 * DAY;
    assert_eq!(utc_date(mar_28), Ok((2024, 3, 28)));
    assert_eq!(next_window(T_2024_02_29, 28), Ok((mar_28, mar_28 + DAY)));
}

#[test]
fn next_window_overflow_does_not_panic() {
    assert_eq!(next_window(u64::MAX, 28), Err(CommonError::Overflow));
}
