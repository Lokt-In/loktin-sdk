use loktin_common::schedule::{current_period, missed_between};
use loktin_common::CommonError;

const START: u64 = 1_792_627_200;
const WEEK: u64 = 7 * 86_400;

#[test]
fn rejects_cadence_zero() {
    assert_eq!(
        current_period(START, 0, START),
        Err(CommonError::InvalidCadence)
    );
    assert_eq!(
        current_period(START, 0, 0),
        Err(CommonError::InvalidCadence)
    );
}

#[test]
fn none_before_start() {
    assert_eq!(current_period(START, WEEK, START - 1), Ok(None));
    assert_eq!(current_period(START, WEEK, 0), Ok(None));
}

#[test]
fn none_before_first_period() {
    // No deposit is due at creation.
    assert_eq!(current_period(START, WEEK, START), Ok(None));
    assert_eq!(current_period(START, WEEK, START + WEEK - 1), Ok(None));
}

#[test]
fn period_boundaries() {
    assert_eq!(current_period(START, WEEK, START + WEEK), Ok(Some(1)));
    assert_eq!(
        current_period(START, WEEK, START + 2 * WEEK - 1),
        Ok(Some(1))
    );
    assert_eq!(current_period(START, WEEK, START + 2 * WEEK), Ok(Some(2)));
    assert_eq!(
        current_period(START, WEEK, START + 10 * WEEK + 5),
        Ok(Some(10))
    );
}

#[test]
fn extreme_values_do_not_panic() {
    assert_eq!(current_period(0, 1, u64::MAX), Ok(Some(u64::MAX)));
    assert_eq!(current_period(u64::MAX, 1, u64::MAX), Ok(None));
    assert_eq!(current_period(0, u64::MAX, u64::MAX), Ok(Some(1)));
}

#[test]
fn missed_between_counts_ended_periods() {
    // Nothing collected yet, and period 1 is current.
    assert_eq!(missed_between(0, 1), 0);
    // Nothing collected yet, and period 4 is current: 1, 2 and 3 ended.
    assert_eq!(missed_between(0, 4), 3);
    // Period 3 collected, and period 3 is still current.
    assert_eq!(missed_between(3, 3), 0);
    // Period 3 collected, and period 4 is current.
    assert_eq!(missed_between(3, 4), 0);
    // Period 3 collected, and period 7 is current: 4, 5 and 6 ended.
    assert_eq!(missed_between(3, 7), 3);
}

#[test]
fn missed_between_extremes_do_not_panic() {
    assert_eq!(missed_between(5, 2), 0);
    assert_eq!(missed_between(0, 0), 0);
    assert_eq!(missed_between(0, u64::MAX), u64::MAX - 1);
    assert_eq!(missed_between(u64::MAX, 0), 0);
}
