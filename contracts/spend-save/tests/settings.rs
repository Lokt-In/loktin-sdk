mod common;

use common::{env, percent, round_up, DAY, NOVEMBER, START, TODAY};
use loktin_spend_save::{DayChange, Destination, Error, SettingsUpdated, SkimSettings};
use soroban_sdk::testutils::Events as _;
use soroban_sdk::Event as _;

const OCTOBER_INDEX: u32 = 2026 * 12 + 9;
const NOVEMBER_INDEX: u32 = OCTOBER_INDEX + 1;

fn update(s: &common::Setup, skim: SkimSettings, cap: Option<i128>, day: u32) {
    s.contract.update_settings(
        &s.user,
        &s.integrator,
        &skim,
        &cap,
        &Destination::Balance,
        &day,
    );
}

#[test]
fn settings_change_skim_cap_and_destination_at_once() {
    let s = common::setup();
    s.enroll_default();
    s.contract.update_settings(
        &s.user,
        &s.integrator,
        &round_up(100),
        &Some(500),
        &Destination::Goal(3),
        &TODAY,
    );
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.contract.address),
        [SettingsUpdated {
            user: s.user.clone(),
            integrator: s.integrator.clone(),
            skim: round_up(100),
            monthly_cap: Some(500),
            destination: Destination::Goal(3),
            withdrawal_day: TODAY,
            pending_day: DayChange::None,
        }
        .to_xdr(&s.env, &s.contract.address)]
    );
    let e = s.contract.enrollment(&s.user, &s.integrator);
    assert_eq!(e.skim, round_up(100));
    assert_eq!(e.monthly_cap, Some(500));
    assert_eq!(e.destination, Destination::Goal(3));
    // The new skim applies to the next spend right away.
    assert_eq!(
        s.contract.preview_skim(&s.user, &s.integrator, &250).skim,
        50
    );
}

#[test]
fn settings_never_change_fee_rates() {
    let s = common::setup_with_fee(100);
    s.env.mock_all_auths();
    s.contract.enroll(
        &s.user,
        &s.integrator,
        &60,
        &percent(1_000),
        &None,
        &Destination::Balance,
        &TODAY,
    );
    s.contract.set_loktin_fee(&0, &s.fee_admin);
    update(&s, percent(2_000), None, 3);
    let e = s.contract.enrollment(&s.user, &s.integrator);
    assert_eq!(e.loktin_fee_bps, 100);
    assert_eq!(e.integrator_fee_bps, 60);
}

#[test]
fn day_change_in_one_month_takes_effect_the_next() {
    let s = common::setup();
    s.mint(&s.user, 10_000);
    s.enroll_default();
    s.contract.save_for_spend(&s.user, &s.integrator, &10_000);
    update(&s, percent(1_000), None, 5);
    assert_eq!(
        s.contract.enrollment(&s.user, &s.integrator).pending_day,
        DayChange::Pending(5, NOVEMBER_INDEX)
    );
    // October keeps the old day: today, the 22nd.
    s.contract.withdraw(&s.user, &s.integrator, &1);
    assert_eq!(
        s.contract.next_window(&s.user, &s.integrator),
        (START, START + DAY)
    );
    // From the 23rd, the next window is the new day in November.
    s.set_time(START + DAY);
    let november_5 = NOVEMBER + 4 * DAY;
    assert_eq!(
        s.contract.next_window(&s.user, &s.integrator),
        (november_5, november_5 + DAY)
    );
    s.set_time(november_5);
    s.contract.withdraw(&s.user, &s.integrator, &1);
    s.set_time(NOVEMBER + 21 * DAY);
    assert_eq!(
        s.contract.try_withdraw(&s.user, &s.integrator, &1),
        Err(Ok(Error::OutsideWindow))
    );
}

#[test]
fn second_day_change_in_one_month_replaces_the_first() {
    let s = common::setup();
    s.enroll_default();
    update(&s, percent(1_000), None, 5);
    update(&s, percent(1_000), None, 10);
    assert_eq!(
        s.contract.enrollment(&s.user, &s.integrator).pending_day,
        DayChange::Pending(10, NOVEMBER_INDEX)
    );
    s.set_time(START + DAY);
    let november_10 = NOVEMBER + 9 * DAY;
    assert_eq!(
        s.contract.next_window(&s.user, &s.integrator),
        (november_10, november_10 + DAY)
    );
}

#[test]
fn changing_back_to_the_current_day_clears_the_pending_one() {
    let s = common::setup();
    s.enroll_default();
    update(&s, percent(1_000), None, 5);
    update(&s, percent(1_000), None, TODAY);
    assert_eq!(
        s.contract.enrollment(&s.user, &s.integrator).pending_day,
        DayChange::None
    );
}

#[test]
fn pending_day_is_promoted_on_the_first_call_in_its_month() {
    let s = common::setup();
    s.mint(&s.user, 1_000);
    s.enroll_default();
    update(&s, percent(1_000), None, 5);
    // Still pending at the last second of October.
    s.set_time(NOVEMBER - 1);
    s.contract.save_for_spend(&s.user, &s.integrator, &10);
    assert_eq!(
        s.contract.enrollment(&s.user, &s.integrator).withdrawal_day,
        TODAY
    );
    // The first call in November moves it into place.
    s.set_time(NOVEMBER);
    s.contract.save_for_spend(&s.user, &s.integrator, &10);
    let e = s.contract.enrollment(&s.user, &s.integrator);
    assert_eq!(e.withdrawal_day, 5);
    assert_eq!(e.pending_day, DayChange::None);
}

#[test]
fn settings_reject_invalid_values() {
    let s = common::setup();
    s.enroll_default();
    let none = SkimSettings {
        percent_bps: None,
        round_up_unit: None,
    };
    let call = |skim: SkimSettings, cap: Option<i128>, day: u32| {
        s.contract.try_update_settings(
            &s.user,
            &s.integrator,
            &skim,
            &cap,
            &Destination::Balance,
            &day,
        )
    };
    assert_eq!(call(none, None, 1), Err(Ok(Error::InvalidSkim)));
    assert_eq!(call(percent(5_001), None, 1), Err(Ok(Error::InvalidSkim)));
    assert_eq!(call(percent(100), Some(0), 1), Err(Ok(Error::InvalidCap)));
    assert_eq!(call(percent(100), None, 0), Err(Ok(Error::InvalidDay)));
    assert_eq!(call(percent(100), None, 29), Err(Ok(Error::InvalidDay)));
}

#[test]
fn settings_reject_unknown_enrolment() {
    let s = common::setup();
    assert_eq!(
        s.contract.try_update_settings(
            &s.user,
            &s.integrator,
            &percent(100),
            &None,
            &Destination::Balance,
            &1,
        ),
        Err(Ok(Error::EnrollmentNotFound))
    );
}

#[test]
fn settings_goal_destination_needs_target_savings() {
    let s = common::setup_in(env(), 0, false);
    s.env.mock_all_auths();
    s.enroll_default();
    assert_eq!(
        s.contract.try_update_settings(
            &s.user,
            &s.integrator,
            &percent(100),
            &None,
            &Destination::Goal(1),
            &TODAY,
        ),
        Err(Ok(Error::DestinationUnavailable))
    );
}

#[test]
fn settings_report_missing_configuration() {
    let s = common::setup();
    s.enroll_default();
    s.env.as_contract(&s.contract.address, || {
        s.env
            .storage()
            .instance()
            .remove(&loktin_spend_save::DataKey::Config);
    });
    assert_eq!(
        s.contract.try_update_settings(
            &s.user,
            &s.integrator,
            &percent(100),
            &None,
            &Destination::Balance,
            &TODAY,
        ),
        Err(Ok(Error::ConfigMissing))
    );
}
