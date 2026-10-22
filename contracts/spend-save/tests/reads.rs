mod common;

use common::{percent, Setup, DAY, NOVEMBER, START, TODAY};
use loktin_spend_save::{Destination, Error, SkimPreview, SkimSettings};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

#[test]
fn preview_skim_shows_the_parts() {
    let s = common::setup();
    s.enroll(
        SkimSettings {
            percent_bps: Some(1_000),
            round_up_unit: Some(100),
        },
        None,
        Destination::Balance,
        TODAY,
    );
    assert_eq!(
        s.contract.preview_skim(&s.user, &s.integrator, &250),
        SkimPreview {
            spent: 250,
            percent_part: 25,
            round_up_part: 50,
            skim: 75,
            cap_trimmed: 0,
            capped: 75,
        }
    );
}

#[test]
fn preview_skim_shows_cap_trimming_and_matches_the_saving() {
    let s = common::setup();
    s.mint(&s.user, 10_000);
    s.enroll(percent(1_000), Some(100), Destination::Balance, TODAY);
    s.contract.save_for_spend(&s.user, &s.integrator, &700);
    let preview = s.contract.preview_skim(&s.user, &s.integrator, &700);
    assert_eq!(preview.skim, 70);
    assert_eq!(preview.cap_trimmed, 40);
    assert_eq!(preview.capped, 30);
    let saving = s.contract.save_for_spend(&s.user, &s.integrator, &700);
    assert_eq!(saving.skim, preview.skim);
    assert_eq!(saving.cap_trimmed, preview.cap_trimmed);
    assert_eq!(saving.to_balance, preview.capped);
}

#[test]
fn preview_skim_uses_a_fresh_cap_in_a_new_month() {
    let s = common::setup();
    s.mint(&s.user, 10_000);
    s.enroll(percent(1_000), Some(100), Destination::Balance, TODAY);
    s.contract.save_for_spend(&s.user, &s.integrator, &1_000);
    s.set_time(NOVEMBER);
    assert_eq!(
        s.contract
            .preview_skim(&s.user, &s.integrator, &1_000)
            .cap_trimmed,
        0
    );
}

#[test]
fn preview_skim_rejects_bad_input() {
    let s = common::setup();
    s.enroll_default();
    for spent in [0, -1] {
        assert_eq!(
            s.contract.try_preview_skim(&s.user, &s.integrator, &spent),
            Err(Ok(Error::InvalidAmount))
        );
    }
    let stranger = Address::generate(&s.env);
    assert_eq!(
        s.contract.try_preview_skim(&stranger, &s.integrator, &1),
        Err(Ok(Error::EnrollmentNotFound))
    );
}

fn window(s: &Setup) -> (u64, u64) {
    s.contract.next_window(&s.user, &s.integrator)
}

#[test]
fn next_window_is_the_open_one_or_the_next() {
    let s = common::setup();
    s.enroll(percent(100), None, Destination::Balance, TODAY);
    assert_eq!(window(&s), (START, START + DAY));
    s.set_time(START + DAY - 1);
    assert_eq!(window(&s), (START, START + DAY));
    s.set_time(START + DAY);
    let november_22 = NOVEMBER + 21 * DAY;
    assert_eq!(window(&s), (november_22, november_22 + DAY));
}

#[test]
fn next_window_later_this_month() {
    let s = common::setup();
    s.enroll(percent(100), None, Destination::Balance, 28);
    assert_eq!(window(&s), (START + 6 * DAY, START + 7 * DAY));
}

#[test]
fn next_window_rejects_unknown_enrolment() {
    let s = common::setup();
    assert_eq!(
        s.contract.try_next_window(&s.user, &s.integrator),
        Err(Ok(Error::EnrollmentNotFound))
    );
}

#[test]
fn enrollment_rejects_unknown_enrolment() {
    let s = common::setup();
    assert_eq!(
        s.contract.try_enrollment(&s.user, &s.integrator),
        Err(Ok(Error::EnrollmentNotFound))
    );
}

#[test]
fn configuration_reads_report_missing_configuration() {
    let s = common::setup();
    s.env.as_contract(&s.contract.address, || {
        s.env
            .storage()
            .instance()
            .remove(&loktin_spend_save::DataKey::Config);
    });
    assert_eq!(s.contract.try_token(), Err(Ok(Error::ConfigMissing)));
    assert_eq!(
        s.contract.try_loktin_fee_bps(),
        Err(Ok(Error::ConfigMissing))
    );
    assert_eq!(
        s.contract.try_fee_recipient(),
        Err(Ok(Error::ConfigMissing))
    );
    assert_eq!(
        s.contract.try_target_savings(),
        Err(Ok(Error::ConfigMissing))
    );
}

#[test]
fn write_functions_report_missing_configuration() {
    let s = common::setup();
    s.mint(&s.user, 1_000);
    s.enroll_default();
    s.env.as_contract(&s.contract.address, || {
        s.env
            .storage()
            .instance()
            .remove(&loktin_spend_save::DataKey::Config);
    });
    let to = soroban_sdk::MuxedAddress::from(&s.payee);
    assert_eq!(
        s.contract
            .try_pay_and_save(&s.user, &s.integrator, &to, &10),
        Err(Ok(Error::ConfigMissing))
    );
    assert_eq!(
        s.contract.try_save_for_spend(&s.user, &s.integrator, &10),
        Err(Ok(Error::ConfigMissing))
    );
    assert_eq!(
        s.contract.try_withdraw(&s.user, &s.integrator, &1),
        Err(Ok(Error::ConfigMissing))
    );
}
