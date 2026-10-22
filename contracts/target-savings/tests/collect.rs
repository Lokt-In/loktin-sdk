mod common;

use common::{Setup, START, WEEK};
use loktin_target_savings::{DepositKind, Deposited, Error, Missed, WithdrawalRule};
use soroban_sdk::testutils::Events as _;
use soroban_sdk::Event as _;

/// A weekly goal of 1,000 toward 10,000, due in 10 weeks, with the owner
/// funded and the allowance approved.
fn funded(s: &Setup) -> u64 {
    s.mint(&s.owner, 100_000);
    s.contract.create_goal(
        &s.owner,
        &10_000,
        &(START + 10 * WEEK),
        &WEEK,
        &1_000,
        &WithdrawalRule::Lock,
        &s.integrator,
        &0,
        &s.allowance(100_000),
    )
}

#[test]
fn collects_due_period_and_emits_event() {
    let s = common::setup();
    let id = funded(&s);
    s.set_time(START + WEEK);
    s.contract.collect(&id);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.contract.address),
        [Deposited {
            goal_id: id,
            owner: s.owner.clone(),
            kind: DepositKind::Scheduled,
            amount: 1_000,
            principal: 1_000,
        }
        .to_xdr(&s.env, &s.contract.address)]
    );
    let goal = s.contract.goal(&id);
    assert_eq!(goal.principal, 1_000);
    assert_eq!(goal.shares, 1_000);
    assert_eq!(goal.last_collected_period, 1);
    assert_eq!(goal.missed_count, 0);
    assert_eq!(s.token.balance(&s.contract.address), 1_000);
    assert_eq!(s.token.allowance(&s.owner, &s.contract.address), 99_000);
}

#[test]
fn period_edges() {
    let s = common::setup();
    let id = funded(&s);
    // One second before period 1.
    s.set_time(START + WEEK - 1);
    assert_eq!(s.contract.try_collect(&id), Err(Ok(Error::NotDue)));
    // Exactly at period 1.
    s.set_time(START + WEEK);
    s.contract.collect(&id);
    assert_eq!(
        s.contract.try_collect(&id),
        Err(Ok(Error::AlreadyCollected))
    );
    // One second before period 2 is still period 1.
    s.set_time(START + 2 * WEEK - 1);
    assert_eq!(
        s.contract.try_collect(&id),
        Err(Ok(Error::AlreadyCollected))
    );
    // One second after period 2 starts.
    s.set_time(START + 2 * WEEK + 1);
    s.contract.collect(&id);
    assert_eq!(s.contract.goal(&id).last_collected_period, 2);
}

#[test]
fn not_due_at_creation() {
    let s = common::setup();
    let id = funded(&s);
    assert_eq!(s.contract.try_collect(&id), Err(Ok(Error::NotDue)));
}

#[test]
fn records_missed_periods_once_they_end() {
    let s = common::setup();
    let id = funded(&s);
    s.set_time(START + 4 * WEEK);
    s.contract.collect(&id);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.contract.address),
        [
            Missed {
                goal_id: id,
                periods: 3,
                missed_count: 3,
            }
            .to_xdr(&s.env, &s.contract.address),
            Deposited {
                goal_id: id,
                owner: s.owner.clone(),
                kind: DepositKind::Scheduled,
                amount: 1_000,
                principal: 1_000,
            }
            .to_xdr(&s.env, &s.contract.address),
        ]
    );
    let goal = s.contract.goal(&id);
    assert_eq!(goal.missed_count, 3);
    assert_eq!(goal.principal, 1_000);
}

#[test]
fn shortfall_does_not_use_up_the_period() {
    let s = common::setup();
    s.contract.create_goal(
        &s.owner,
        &10_000,
        &(START + 10 * WEEK),
        &WEEK,
        &1_000,
        &WithdrawalRule::Lock,
        &s.integrator,
        &0,
        &s.allowance(100_000),
    );
    s.set_time(START + WEEK);
    // Balance short by one unit.
    s.mint(&s.owner, 999);
    assert_eq!(s.contract.try_collect(&1), Err(Ok(Error::Shortfall)));
    assert_eq!(s.contract.goal(&1).last_collected_period, 0);
    // The period stays collectible once the balance is there.
    s.mint(&s.owner, 1);
    s.contract.collect(&1);
    assert_eq!(s.contract.goal(&1).principal, 1_000);
}

#[test]
fn allowance_shortfall_does_not_use_up_the_period() {
    let s = common::setup();
    s.mint(&s.owner, 100_000);
    s.contract.create_goal(
        &s.owner,
        &10_000,
        &(START + 10 * WEEK),
        &WEEK,
        &1_000,
        &WithdrawalRule::Lock,
        &s.integrator,
        &0,
        &s.allowance(999),
    );
    s.set_time(START + WEEK);
    assert_eq!(s.contract.try_collect(&1), Err(Ok(Error::Shortfall)));
    let expiry = s.env.ledger().sequence() + 1_000;
    s.token
        .approve(&s.owner, &s.contract.address, &1_000, &expiry);
    s.contract.collect(&1);
    assert_eq!(s.contract.goal(&1).principal, 1_000);
}

#[test]
fn expired_allowance_is_a_shortfall() {
    let s = common::setup();
    s.mint(&s.owner, 100_000);
    let expiry = s.env.ledger().sequence() + 10;
    s.contract.create_goal(
        &s.owner,
        &10_000,
        &(START + 10 * WEEK),
        &WEEK,
        &1_000,
        &WithdrawalRule::Lock,
        &s.integrator,
        &0,
        &Some((100_000, expiry)),
    );
    s.advance_ledgers(11);
    s.set_time(START + WEEK);
    assert_eq!(s.contract.try_collect(&1), Err(Ok(Error::Shortfall)));
}

#[test]
fn last_collection_takes_only_what_is_still_needed() {
    let s = common::setup();
    let id = funded(&s);
    s.contract.deposit(&s.owner, &id, &9_500);
    s.set_time(START + WEEK);
    s.contract.collect(&id);
    let goal = s.contract.goal(&id);
    assert_eq!(goal.principal, 10_000);
    assert_eq!(s.token.balance(&s.contract.address), 10_000);
    s.set_time(START + 2 * WEEK);
    assert_eq!(s.contract.try_collect(&id), Err(Ok(Error::TargetReached)));
}

#[test]
fn target_reached_by_manual_deposit_stops_collection() {
    let s = common::setup();
    let id = funded(&s);
    s.contract.deposit(&s.owner, &id, &10_000);
    s.set_time(START + WEEK);
    assert_eq!(s.contract.try_collect(&id), Err(Ok(Error::TargetReached)));
}

#[test]
fn period_due_exactly_at_deadline_is_collected_and_later_ones_are_not() {
    let s = common::setup();
    let id = funded(&s);
    // Period 10 is due exactly at the deadline.
    s.set_time(START + 10 * WEEK);
    s.contract.collect(&id);
    assert_eq!(s.contract.goal(&id).last_collected_period, 10);
    // Any call after the deadline is refused, even inside period 10.
    s.set_time(START + 10 * WEEK + 1);
    assert_eq!(s.contract.try_collect(&id), Err(Ok(Error::DeadlinePassed)));
    s.set_time(START + 11 * WEEK);
    assert_eq!(s.contract.try_collect(&id), Err(Ok(Error::DeadlinePassed)));
}

#[test]
fn uncollected_last_period_cannot_be_collected_after_the_deadline() {
    let s = common::setup();
    let id = funded(&s);
    // Period 10 is due exactly at the deadline and is left uncollected.
    s.set_time(START + 10 * WEEK + 1);
    assert_eq!(s.contract.try_collect(&id), Err(Ok(Error::DeadlinePassed)));
    let goal = s.contract.goal(&id);
    assert_eq!(goal.principal, 0);
    assert_eq!(goal.last_collected_period, 0);
    s.set_time(START + 10 * WEEK + common::DAY);
    assert_eq!(s.contract.try_collect(&id), Err(Ok(Error::DeadlinePassed)));
}

#[test]
fn collect_rejects_unknown_goal() {
    let s = common::setup();
    assert_eq!(s.contract.try_collect(&9), Err(Ok(Error::GoalNotFound)));
}
