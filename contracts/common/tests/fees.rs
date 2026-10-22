use loktin_common::fees::{
    bps_of, withdrawal_breakdown, Breakdown, BPS_DENOMINATOR, MAX_INTEGRATOR_FEE_BPS,
    MAX_LOKTIN_FEE_BPS, MAX_PENALTY_BPS,
};
use loktin_common::CommonError;

#[test]
fn constants() {
    assert_eq!(BPS_DENOMINATOR, 10_000);
    assert_eq!(MAX_LOKTIN_FEE_BPS, 100);
    assert_eq!(MAX_INTEGRATOR_FEE_BPS, 100);
    assert_eq!(MAX_PENALTY_BPS, 1_000);
}

#[test]
fn bps_of_zero_amount_and_zero_rate() {
    assert_eq!(bps_of(0, 0), Ok(0));
    assert_eq!(bps_of(0, 10_000), Ok(0));
    assert_eq!(bps_of(1_000_000, 0), Ok(0));
}

#[test]
fn bps_of_rounds_down() {
    assert_eq!(bps_of(10_000, 100), Ok(100));
    assert_eq!(bps_of(9_999, 100), Ok(99));
    assert_eq!(bps_of(99, 100), Ok(0));
    assert_eq!(bps_of(1, 9_999), Ok(0));
}

#[test]
fn bps_of_full_rate_returns_amount() {
    assert_eq!(bps_of(123_456_789, 10_000), Ok(123_456_789));
}

#[test]
fn bps_of_rejects_rate_above_denominator() {
    assert_eq!(bps_of(100, 10_001), Err(CommonError::RateAboveCap));
    assert_eq!(bps_of(100, u32::MAX), Err(CommonError::RateAboveCap));
}

#[test]
fn bps_of_rejects_negative_amount() {
    assert_eq!(bps_of(-1, 100), Err(CommonError::InvalidAmount));
    assert_eq!(bps_of(i128::MIN, 0), Err(CommonError::InvalidAmount));
}

#[test]
fn bps_of_near_max_overflows_without_panic() {
    assert_eq!(bps_of(i128::MAX, 100), Err(CommonError::Overflow));
    assert_eq!(bps_of(i128::MAX - 1, 2), Err(CommonError::Overflow));
    assert_eq!(bps_of(i128::MAX, 1), Ok(i128::MAX / 10_000));
    assert_eq!(bps_of(i128::MAX, 0), Ok(0));
}

#[test]
fn breakdown_zero_principal() {
    assert_eq!(
        withdrawal_breakdown(
            0,
            MAX_PENALTY_BPS,
            MAX_LOKTIN_FEE_BPS,
            MAX_INTEGRATOR_FEE_BPS
        ),
        Ok(Breakdown {
            penalty: 0,
            loktin_fee: 0,
            integrator_fee: 0,
            to_user: 0,
        })
    );
}

#[test]
fn breakdown_zero_rates_pays_everything_to_user() {
    assert_eq!(
        withdrawal_breakdown(5_000_000, 0, 0, 0),
        Ok(Breakdown {
            penalty: 0,
            loktin_fee: 0,
            integrator_fee: 0,
            to_user: 5_000_000,
        })
    );
}

#[test]
fn breakdown_rates_at_cap() {
    assert_eq!(
        withdrawal_breakdown(1_000_000, 1_000, 100, 100),
        Ok(Breakdown {
            penalty: 100_000,
            loktin_fee: 10_000,
            integrator_fee: 10_000,
            to_user: 880_000,
        })
    );
}

#[test]
fn breakdown_rounds_each_part_down() {
    assert_eq!(
        withdrawal_breakdown(999, 1_000, 100, 100),
        Ok(Breakdown {
            penalty: 99,
            loktin_fee: 9,
            integrator_fee: 9,
            to_user: 882,
        })
    );
}

#[test]
fn breakdown_rejects_rate_above_cap() {
    assert_eq!(
        withdrawal_breakdown(1_000, MAX_PENALTY_BPS + 1, 0, 0),
        Err(CommonError::RateAboveCap)
    );
    assert_eq!(
        withdrawal_breakdown(1_000, 0, MAX_LOKTIN_FEE_BPS + 1, 0),
        Err(CommonError::RateAboveCap)
    );
    assert_eq!(
        withdrawal_breakdown(1_000, 0, 0, MAX_INTEGRATOR_FEE_BPS + 1),
        Err(CommonError::RateAboveCap)
    );
}

#[test]
fn breakdown_rejects_negative_principal() {
    assert_eq!(
        withdrawal_breakdown(-1, 0, 0, 0),
        Err(CommonError::InvalidAmount)
    );
}

#[test]
fn breakdown_near_max_overflows_without_panic() {
    assert_eq!(
        withdrawal_breakdown(i128::MAX, 1_000, 0, 0),
        Err(CommonError::Overflow)
    );
    assert_eq!(
        withdrawal_breakdown(i128::MAX, 0, 0, 0),
        Ok(Breakdown {
            penalty: 0,
            loktin_fee: 0,
            integrator_fee: 0,
            to_user: i128::MAX,
        })
    );
}

#[test]
fn error_codes() {
    assert_eq!(CommonError::InvalidAmount.code(), 1);
    assert_eq!(CommonError::Overflow.code(), 2);
    assert_eq!(CommonError::RateAboveCap.code(), 3);
    assert_eq!(CommonError::InvalidDay.code(), 4);
    assert_eq!(CommonError::InvalidCadence.code(), 5);
}
