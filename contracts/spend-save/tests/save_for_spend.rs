mod common;

use common::{percent, NOVEMBER};
use loktin_spend_save::{Destination, Error, Saved, Saving};
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{Address, Event as _};

fn saving(skim: i128, cap_trimmed: i128, shortfall: i128, to_balance: i128) -> Saving {
    Saving {
        skim,
        cap_trimmed,
        shortfall,
        to_balance,
        to_goal: 0,
        goal_id: None,
    }
}

#[test]
fn saves_the_skim_and_emits_event() {
    let s = common::setup();
    s.mint(&s.user, 1_000);
    s.enroll_default();
    assert_eq!(
        s.contract.save_for_spend(&s.user, &s.integrator, &2_000),
        saving(200, 0, 0, 200)
    );
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.contract.address),
        [Saved {
            user: s.user.clone(),
            integrator: s.integrator.clone(),
            spent: 2_000,
            skim: 200,
            cap_trimmed: 0,
            shortfall: 0,
            to_balance: 200,
            to_goal: 0,
            goal_id: None,
        }
        .to_xdr(&s.env, &s.contract.address)]
    );
    assert_eq!(s.token.balance(&s.user), 800);
    assert_eq!(s.principal(), 200);
}

#[test]
fn save_for_spend_rejects_amounts_not_above_zero() {
    let s = common::setup();
    s.enroll_default();
    for spent in [0, -1] {
        assert_eq!(
            s.contract
                .try_save_for_spend(&s.user, &s.integrator, &spent),
            Err(Ok(Error::InvalidAmount))
        );
    }
}

#[test]
fn save_for_spend_shrinks_to_the_balance() {
    let s = common::setup();
    s.mint(&s.user, 30);
    s.enroll_default();
    assert_eq!(
        s.contract.save_for_spend(&s.user, &s.integrator, &1_000),
        saving(100, 0, 70, 30)
    );
}

#[test]
fn save_for_spend_with_empty_wallet_records_the_shortfall() {
    let s = common::setup();
    s.enroll_default();
    assert_eq!(
        s.contract.save_for_spend(&s.user, &s.integrator, &1_000),
        saving(100, 0, 100, 0)
    );
    assert_eq!(
        s.env
            .events()
            .all()
            .filter_by_contract(&s.contract.address)
            .events()
            .len(),
        1
    );
}

#[test]
fn cap_reached_exactly_then_trims_everything() {
    let s = common::setup();
    s.mint(&s.user, 10_000);
    s.enroll(percent(1_000), Some(100), Destination::Balance, 1);
    assert_eq!(
        s.contract.save_for_spend(&s.user, &s.integrator, &600),
        saving(60, 0, 0, 60)
    );
    assert_eq!(
        s.contract.save_for_spend(&s.user, &s.integrator, &400),
        saving(40, 0, 0, 40)
    );
    let e = s.contract.enrollment(&s.user, &s.integrator);
    assert_eq!(e.saved_this_month, 100);
    assert_eq!(
        s.contract.save_for_spend(&s.user, &s.integrator, &500),
        saving(50, 50, 0, 0)
    );
    assert_eq!(s.principal(), 100);
}

#[test]
fn cap_trims_part_of_a_skim() {
    let s = common::setup();
    s.mint(&s.user, 10_000);
    s.enroll(percent(1_000), Some(100), Destination::Balance, 1);
    s.contract.save_for_spend(&s.user, &s.integrator, &700);
    assert_eq!(
        s.contract.save_for_spend(&s.user, &s.integrator, &700),
        saving(70, 40, 0, 30)
    );
}

#[test]
fn new_month_starts_a_new_cap() {
    let s = common::setup();
    s.mint(&s.user, 10_000);
    s.enroll(percent(1_000), Some(100), Destination::Balance, 1);
    s.contract.save_for_spend(&s.user, &s.integrator, &1_000);
    s.set_time(NOVEMBER - 1);
    assert_eq!(
        s.contract.save_for_spend(&s.user, &s.integrator, &1_000),
        saving(100, 100, 0, 0)
    );
    s.set_time(NOVEMBER);
    assert_eq!(
        s.contract.save_for_spend(&s.user, &s.integrator, &1_000),
        saving(100, 0, 0, 100)
    );
    let e = s.contract.enrollment(&s.user, &s.integrator);
    assert_eq!(e.saved_this_month, 100);
    assert_eq!(e.month_index, 2026 * 12 + 10);
    assert_eq!(e.total_saved, 200);
}

#[test]
fn save_for_spend_rejects_unknown_enrolment() {
    let s = common::setup();
    let stranger = Address::generate(&s.env);
    assert_eq!(
        s.contract.try_save_for_spend(&s.user, &stranger, &10),
        Err(Ok(Error::EnrollmentNotFound))
    );
}

#[test]
fn largest_round_up_unit_skims_no_more_than_the_spend() {
    let s = common::setup();
    s.mint(&s.user, 1_000_000);
    s.enroll(common::round_up(i128::MAX), None, Destination::Balance, 1);
    assert_eq!(s.contract.preview_skim(&s.user, &s.integrator, &7).skim, 7);
    assert_eq!(
        s.contract.save_for_spend(&s.user, &s.integrator, &7),
        saving(7, 0, 0, 7)
    );
    assert_eq!(s.token.balance(&s.user), 999_993);
}

#[test]
fn unit_larger_than_the_spend_skims_the_spend() {
    let s = common::setup();
    s.mint(&s.user, 10_000);
    s.enroll(common::round_up(1_000), None, Destination::Balance, 1);
    // Rounding 300 up to 1,000 would add 700; the skim stops at the spend.
    assert_eq!(
        s.contract.save_for_spend(&s.user, &s.integrator, &300),
        saving(300, 0, 0, 300)
    );
}

#[test]
fn percent_and_round_up_together_are_cut_to_the_spend() {
    let s = common::setup();
    s.mint(&s.user, 10_000);
    let skim = loktin_spend_save::SkimSettings {
        percent_bps: Some(5_000),
        round_up_unit: Some(100),
    };
    s.enroll(skim, None, Destination::Balance, 1);
    // 50% of 60 is 30, and rounding 60 up to 100 adds 40: 70 is cut to 60.
    let preview = s.contract.preview_skim(&s.user, &s.integrator, &60);
    assert_eq!(preview.percent_part, 30);
    assert_eq!(preview.round_up_part, 40);
    assert_eq!(preview.skim, 60);
    assert_eq!(
        s.contract.save_for_spend(&s.user, &s.integrator, &60),
        saving(60, 0, 0, 60)
    );
}
