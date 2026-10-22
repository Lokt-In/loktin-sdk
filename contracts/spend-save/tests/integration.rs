//! T4: skims into a real Target Savings goal (P15, S10), with a real Stellar
//! asset contract as the token.

mod common;

use common::{percent, Setup, START, TODAY, WEEK};
use loktin_spend_save::{Destination, Saving};
use loktin_target_savings::WithdrawalRule;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, MuxedAddress};

/// Enrols the user with a 10% skim aimed at `goal_id`.
fn aim_at(s: &Setup, goal_id: u64) {
    s.enroll(percent(1_000), None, Destination::Goal(goal_id), TODAY);
}

fn to_balance(skim: i128) -> Saving {
    Saving {
        skim,
        cap_trimmed: 0,
        shortfall: 0,
        to_balance: skim,
        to_goal: 0,
        goal_id: None,
    }
}

#[test]
fn skim_goes_into_the_goal() {
    let s = common::setup();
    s.mint(&s.user, 10_000);
    let goal = s.create_goal(5_000);
    aim_at(&s, goal);
    let saving = s.contract.save_for_spend(&s.user, &s.integrator, &1_000);
    assert_eq!(
        saving,
        Saving {
            skim: 100,
            cap_trimmed: 0,
            shortfall: 0,
            to_balance: 0,
            to_goal: 100,
            goal_id: Some(goal),
        }
    );
    assert_eq!(s.savings.goal(&goal).principal, 100);
    assert_eq!(s.token.balance(&s.savings.address), 100);
    // The goal's share is not part of the Spend & Save balance, but it
    // counts as saved this month.
    let e = s.contract.enrollment(&s.user, &s.integrator);
    assert_eq!(e.principal, 0);
    assert_eq!(s.token.balance(&s.contract.address), 0);
    assert_eq!(e.saved_this_month, 100);
    assert_eq!(e.total_saved, 100);
}

#[test]
fn pay_and_save_into_the_goal() {
    let s = common::setup();
    s.mint(&s.user, 10_000);
    let goal = s.create_goal(5_000);
    aim_at(&s, goal);
    let to = MuxedAddress::from(&s.payee);
    let saving = s.contract.pay_and_save(&s.user, &s.integrator, &to, &2_000);
    assert_eq!(saving.to_goal, 200);
    assert_eq!(s.token.balance(&s.payee), 2_000);
    assert_eq!(s.savings.goal(&goal).principal, 200);
    assert_eq!(s.token.balance(&s.user), 7_800);
}

#[test]
fn skim_above_what_the_goal_needs_leaves_the_rest_in_the_balance() {
    let s = common::setup();
    s.mint(&s.user, 10_000);
    let goal = s.create_goal(30);
    aim_at(&s, goal);
    let saving = s.contract.save_for_spend(&s.user, &s.integrator, &1_000);
    assert_eq!(saving.to_goal, 30);
    assert_eq!(saving.to_balance, 70);
    assert_eq!(saving.goal_id, Some(goal));
    assert_eq!(s.savings.goal(&goal).principal, 30);
    assert_eq!(s.principal(), 70);
    // Once full, the goal takes nothing more.
    assert_eq!(
        s.contract.save_for_spend(&s.user, &s.integrator, &1_000),
        to_balance(100)
    );
}

#[test]
fn closed_goal_sends_the_skim_to_the_balance() {
    let s = common::setup();
    s.mint(&s.user, 10_000);
    let goal = s.create_goal(5_000);
    s.savings.withdraw(&s.user, &goal);
    aim_at(&s, goal);
    assert_eq!(
        s.contract.save_for_spend(&s.user, &s.integrator, &1_000),
        to_balance(100)
    );
}

#[test]
fn missing_goal_sends_the_skim_to_the_balance() {
    let s = common::setup();
    s.mint(&s.user, 10_000);
    aim_at(&s, 99);
    assert_eq!(
        s.contract.save_for_spend(&s.user, &s.integrator, &1_000),
        to_balance(100)
    );
}

#[test]
fn full_goal_sends_the_skim_to_the_balance() {
    let s = common::setup();
    s.mint(&s.user, 10_000);
    let goal = s.create_goal(500);
    s.savings.deposit(&s.user, &goal, &500);
    aim_at(&s, goal);
    assert_eq!(
        s.contract.save_for_spend(&s.user, &s.integrator, &1_000),
        to_balance(100)
    );
}

#[test]
fn goal_takes_a_skim_at_its_deadline_and_not_after() {
    let s = common::setup();
    s.mint(&s.user, 10_000);
    let goal = s.create_goal(5_000);
    aim_at(&s, goal);
    let deadline = START + 10 * WEEK;
    s.set_time(deadline);
    assert_eq!(
        s.contract
            .save_for_spend(&s.user, &s.integrator, &1_000)
            .to_goal,
        100
    );
    s.set_time(deadline + 1);
    assert_eq!(
        s.contract.save_for_spend(&s.user, &s.integrator, &1_000),
        to_balance(100)
    );
    assert_eq!(s.savings.goal(&goal).principal, 100);
}

#[test]
fn someone_else_s_goal_sends_the_skim_to_the_balance() {
    let s = common::setup();
    s.mint(&s.user, 10_000);
    let other = Address::generate(&s.env);
    let goal = s.savings.create_goal(
        &other,
        &5_000,
        &(START + 10 * WEEK),
        &WEEK,
        &1,
        &WithdrawalRule::Lock,
        &s.integrator,
        &0,
        &None,
    );
    aim_at(&s, goal);
    assert_eq!(
        s.contract.save_for_spend(&s.user, &s.integrator, &1_000),
        to_balance(100)
    );
    assert_eq!(s.savings.goal(&goal).principal, 0);
}

#[test]
fn paused_target_savings_sends_the_skim_to_the_balance_and_the_payment_succeeds() {
    let s = common::setup();
    s.mint(&s.user, 10_000);
    let goal = s.create_goal(5_000);
    aim_at(&s, goal);
    s.savings.pause(&s.pauser);
    let to = MuxedAddress::from(&s.payee);
    assert_eq!(
        s.contract.pay_and_save(&s.user, &s.integrator, &to, &1_000),
        to_balance(100)
    );
    assert_eq!(s.token.balance(&s.payee), 1_000);
    assert_eq!(s.savings.goal(&goal).principal, 0);
    assert_eq!(s.principal(), 100);
    assert_eq!(s.token.balance(&s.contract.address), 100);
}
