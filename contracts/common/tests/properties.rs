use loktin_common::calendar::month_index;
use loktin_common::fees::{
    bps_of, withdrawal_breakdown, MAX_INTEGRATOR_FEE_BPS, MAX_LOKTIN_FEE_BPS, MAX_PENALTY_BPS,
};
use loktin_common::schedule::current_period;
use proptest::prelude::*;

// Largest principal for which `principal * 10_000` fits in an i128.
const MAX_PRINCIPAL: i128 = i128::MAX / 10_000;

// 9999-12-31 23:59:59 UTC.
const MAX_TS: u64 = 253_402_300_799;

proptest! {
    #[test]
    fn breakdown_sums_to_principal(
        principal in 0..=MAX_PRINCIPAL,
        penalty_bps in 0..=MAX_PENALTY_BPS,
        loktin_fee_bps in 0..=MAX_LOKTIN_FEE_BPS,
        integrator_fee_bps in 0..=MAX_INTEGRATOR_FEE_BPS,
    ) {
        let b = withdrawal_breakdown(principal, penalty_bps, loktin_fee_bps, integrator_fee_bps)
            .unwrap();
        prop_assert_eq!(b.penalty + b.loktin_fee + b.integrator_fee + b.to_user, principal);
        prop_assert!(b.to_user >= 0);
    }

    #[test]
    fn each_fee_is_at_most_its_cap_share(
        principal in 0..=MAX_PRINCIPAL,
        penalty_bps in 0..=MAX_PENALTY_BPS,
        loktin_fee_bps in 0..=MAX_LOKTIN_FEE_BPS,
        integrator_fee_bps in 0..=MAX_INTEGRATOR_FEE_BPS,
    ) {
        let b = withdrawal_breakdown(principal, penalty_bps, loktin_fee_bps, integrator_fee_bps)
            .unwrap();
        prop_assert!(b.penalty <= bps_of(principal, MAX_PENALTY_BPS).unwrap());
        prop_assert!(b.loktin_fee <= bps_of(principal, MAX_LOKTIN_FEE_BPS).unwrap());
        prop_assert!(b.integrator_fee <= bps_of(principal, MAX_INTEGRATOR_FEE_BPS).unwrap());
    }

    #[test]
    fn month_index_never_decreases(a in 0..=MAX_TS, b in 0..=MAX_TS) {
        let (earlier, later) = if a <= b { (a, b) } else { (b, a) };
        prop_assert!(month_index(earlier).unwrap() <= month_index(later).unwrap());
    }

    #[test]
    fn current_period_never_decreases(
        start in any::<u64>(),
        cadence in 1..=u64::MAX,
        a in any::<u64>(),
        b in any::<u64>(),
    ) {
        let (earlier, later) = if a <= b { (a, b) } else { (b, a) };
        let first = current_period(start, cadence, earlier).unwrap();
        let second = current_period(start, cadence, later).unwrap();
        // `None` sorts before every `Some`, so this also covers the time before
        // the first period.
        prop_assert!(first <= second);
    }
}
