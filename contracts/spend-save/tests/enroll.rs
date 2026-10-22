mod common;

use common::{env, percent, round_up, TODAY};
use loktin_spend_save::{
    DayChange, Destination, Enrolled, Enrollment, Error, SkimSettings, MAX_ENROLLMENTS,
};
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{Address, Event as _};

#[allow(clippy::type_complexity)]
fn try_enroll(
    s: &common::Setup,
    integrator: &Address,
    integrator_fee_bps: u32,
    skim: SkimSettings,
    monthly_cap: Option<i128>,
    destination: Destination,
    day: u32,
) -> Result<Result<(), soroban_sdk::ConversionError>, Result<Error, soroban_sdk::InvokeError>> {
    s.contract.try_enroll(
        &s.user,
        integrator,
        &integrator_fee_bps,
        &skim,
        &monthly_cap,
        &destination,
        &day,
    )
}

#[test]
fn enroll_stores_enrolment_and_emits_event() {
    let s = common::setup_with_fee(100);
    s.env.mock_all_auths();
    let skim = SkimSettings {
        percent_bps: Some(500),
        round_up_unit: Some(100),
    };
    s.contract.enroll(
        &s.user,
        &s.integrator,
        &50,
        &skim,
        &Some(10_000),
        &Destination::Balance,
        &5,
    );
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.contract.address),
        [Enrolled {
            user: s.user.clone(),
            integrator: s.integrator.clone(),
            integrator_fee_bps: 50,
            loktin_fee_bps: 100,
            skim,
            monthly_cap: Some(10_000),
            destination: Destination::Balance,
            withdrawal_day: 5,
        }
        .to_xdr(&s.env, &s.contract.address)]
    );
    assert_eq!(
        s.contract.enrollment(&s.user, &s.integrator),
        Enrollment {
            user: s.user.clone(),
            integrator: s.integrator.clone(),
            integrator_fee_bps: 50,
            loktin_fee_bps: 100,
            skim,
            monthly_cap: Some(10_000),
            destination: Destination::Balance,
            withdrawal_day: 5,
            pending_day: DayChange::None,
            principal: 0,
            shares: 0,
            month_index: 2026 * 12 + 9,
            saved_this_month: 0,
            total_spent: 0,
            total_saved: 0,
        }
    );
}

#[test]
fn enroll_accepts_today_as_withdrawal_day() {
    let s = common::setup();
    s.enroll(percent(1_000), None, Destination::Balance, TODAY);
    // The window is open right away.
    s.mint(&s.user, 1_000);
    s.contract.save_for_spend(&s.user, &s.integrator, &1_000);
    s.contract.withdraw(&s.user, &s.integrator, &100);
}

#[test]
fn enroll_integrator_fee_at_cap_is_accepted_and_above_is_rejected() {
    let s = common::setup();
    let other = Address::generate(&s.env);
    assert_eq!(
        try_enroll(
            &s,
            &s.integrator,
            101,
            percent(100),
            None,
            Destination::Balance,
            1
        ),
        Err(Ok(Error::RateAboveCap))
    );
    assert_eq!(
        try_enroll(&s, &other, 100, percent(100), None, Destination::Balance, 1),
        Ok(Ok(()))
    );
}

#[test]
fn enroll_day_bounds() {
    let s = common::setup();
    for day in [0, 29] {
        assert_eq!(
            try_enroll(
                &s,
                &s.integrator,
                0,
                percent(100),
                None,
                Destination::Balance,
                day
            ),
            Err(Ok(Error::InvalidDay))
        );
    }
    for day in [1, 28] {
        let integrator = Address::generate(&s.env);
        assert_eq!(
            try_enroll(
                &s,
                &integrator,
                0,
                percent(100),
                None,
                Destination::Balance,
                day
            ),
            Ok(Ok(()))
        );
    }
}

#[test]
fn enroll_fifth_is_accepted_and_sixth_is_rejected() {
    let s = common::setup();
    for _ in 0..MAX_ENROLLMENTS {
        let integrator = Address::generate(&s.env);
        assert_eq!(
            try_enroll(
                &s,
                &integrator,
                0,
                percent(100),
                None,
                Destination::Balance,
                1
            ),
            Ok(Ok(()))
        );
    }
    let sixth = Address::generate(&s.env);
    assert_eq!(
        try_enroll(&s, &sixth, 0, percent(100), None, Destination::Balance, 1),
        Err(Ok(Error::TooManyEnrollments))
    );
}

#[test]
fn enroll_rejects_duplicate() {
    let s = common::setup();
    s.enroll_default();
    assert_eq!(
        try_enroll(
            &s,
            &s.integrator,
            0,
            percent(100),
            None,
            Destination::Balance,
            1
        ),
        Err(Ok(Error::AlreadyEnrolled))
    );
}

#[test]
fn enroll_skim_settings_bounds() {
    let s = common::setup();
    let invalid = [
        SkimSettings {
            percent_bps: None,
            round_up_unit: None,
        },
        percent(99),
        percent(5_001),
        round_up(0),
        round_up(-1),
        SkimSettings {
            percent_bps: Some(100),
            round_up_unit: Some(0),
        },
    ];
    for skim in invalid {
        assert_eq!(
            try_enroll(&s, &s.integrator, 0, skim, None, Destination::Balance, 1),
            Err(Ok(Error::InvalidSkim))
        );
    }
    for skim in [percent(100), percent(5_000), round_up(1)] {
        let integrator = Address::generate(&s.env);
        assert_eq!(
            try_enroll(&s, &integrator, 0, skim, None, Destination::Balance, 1),
            Ok(Ok(()))
        );
    }
}

#[test]
fn enroll_cap_bounds() {
    let s = common::setup();
    for cap in [0, -1] {
        assert_eq!(
            try_enroll(
                &s,
                &s.integrator,
                0,
                percent(100),
                Some(cap),
                Destination::Balance,
                1
            ),
            Err(Ok(Error::InvalidCap))
        );
    }
    assert_eq!(
        try_enroll(
            &s,
            &s.integrator,
            0,
            percent(100),
            Some(1),
            Destination::Balance,
            1
        ),
        Ok(Ok(()))
    );
}

#[test]
fn enroll_goal_destination_needs_target_savings() {
    let s = common::setup_in(env(), 0, false);
    s.env.mock_all_auths();
    assert_eq!(
        try_enroll(
            &s,
            &s.integrator,
            0,
            percent(100),
            None,
            Destination::Goal(1),
            1
        ),
        Err(Ok(Error::DestinationUnavailable))
    );
    assert_eq!(
        try_enroll(
            &s,
            &s.integrator,
            0,
            percent(100),
            None,
            Destination::Balance,
            1
        ),
        Ok(Ok(()))
    );
}

#[test]
fn enroll_accepts_goal_destination_with_target_savings() {
    let s = common::setup();
    assert_eq!(
        try_enroll(
            &s,
            &s.integrator,
            0,
            percent(100),
            None,
            Destination::Goal(7),
            1
        ),
        Ok(Ok(()))
    );
}

#[test]
fn enroll_rejects_this_contract_as_integrator() {
    let s = common::setup();
    let contract = s.contract.address.clone();
    assert_eq!(
        try_enroll(
            &s,
            &contract,
            100,
            percent(100),
            None,
            Destination::Balance,
            1
        ),
        Err(Ok(Error::InvalidIntegrator))
    );
}

#[test]
fn enroll_copies_the_loktin_fee_rate() {
    let s = common::setup_with_fee(100);
    s.env.mock_all_auths();
    s.enroll_default();
    s.contract.set_loktin_fee(&0, &s.fee_admin);
    let later = Address::generate(&s.env);
    try_enroll(&s, &later, 0, percent(100), None, Destination::Balance, 1)
        .unwrap()
        .unwrap();
    assert_eq!(
        s.contract.enrollment(&s.user, &s.integrator).loktin_fee_bps,
        100
    );
    assert_eq!(s.contract.enrollment(&s.user, &later).loktin_fee_bps, 0);
}

#[test]
fn enroll_reports_missing_configuration() {
    let s = common::setup();
    s.env.as_contract(&s.contract.address, || {
        s.env
            .storage()
            .instance()
            .remove(&loktin_spend_save::DataKey::Config);
    });
    assert_eq!(
        try_enroll(
            &s,
            &s.integrator,
            0,
            percent(100),
            None,
            Destination::Balance,
            1
        ),
        Err(Ok(Error::ConfigMissing))
    );
}
