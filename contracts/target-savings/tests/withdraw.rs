mod common;

use common::{Setup, START, WEEK};
use loktin_target_savings::{Error, GoalClosed, Withdrawal, WithdrawalRule, Withdrawn};
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{Address, Event as _};

/// A goal of 10,000 due in 10 weeks, holding `principal`, created through an
/// integrator charging 1% on an instance charging 1%.
fn with_fees(rule: WithdrawalRule, principal: i128) -> (Setup<'static>, u64) {
    let s = common::setup_with_fee(100);
    s.env.mock_all_auths();
    s.mint(&s.owner, principal);
    let id = s.contract.create_goal(
        &s.owner,
        &10_000,
        &(START + 10 * WEEK),
        &WEEK,
        &1_000,
        &rule,
        &s.integrator,
        &100,
        &None,
    );
    if principal > 0 {
        s.contract.deposit(&s.owner, &id, &principal);
    }
    (s, id)
}

fn assert_closed(s: &Setup, id: u64) {
    assert_eq!(s.contract.try_goal(&id), Err(Ok(Error::GoalNotFound)));
    assert!(s.contract.user_goals(&s.owner).iter().all(|g| g.id != id));
}

#[test]
fn early_withdrawal_pays_penalty_and_fees_and_emits_events() {
    let (s, id) = with_fees(WithdrawalRule::Penalty(1_000), 5_000);
    let expected = Withdrawal {
        amount: 5_000,
        penalty: 500,
        loktin_fee: 50,
        integrator_fee: 50,
        to_user: 4_400,
    };
    assert_eq!(s.contract.preview_withdraw(&id), expected);
    assert_eq!(s.contract.withdraw(&s.owner, &id), expected);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.contract.address),
        [
            Withdrawn {
                goal_id: id,
                owner: s.owner.clone(),
                amount: 5_000,
                penalty: 500,
                loktin_fee: 50,
                integrator_fee: 50,
                to_user: 4_400,
            }
            .to_xdr(&s.env, &s.contract.address),
            GoalClosed {
                goal_id: id,
                owner: s.owner.clone(),
            }
            .to_xdr(&s.env, &s.contract.address),
        ]
    );
    assert_eq!(s.token.balance(&s.owner), 4_400);
    assert_eq!(s.token.balance(&s.integrator), 550);
    assert_eq!(s.token.balance(&s.fee_recipient), 50);
    assert_eq!(s.token.balance(&s.contract.address), 0);
    assert_closed(&s, id);
}

#[test]
fn no_penalty_once_target_is_reached() {
    let (s, id) = with_fees(WithdrawalRule::Penalty(1_000), 10_000);
    let w = s.contract.withdraw(&s.owner, &id);
    assert_eq!(w.penalty, 0);
    assert_eq!(w.to_user, 9_800);
    assert_eq!(s.token.balance(&s.integrator), 100);
}

#[test]
fn penalty_applies_one_second_before_deadline_and_not_at_it() {
    let (s, id) = with_fees(WithdrawalRule::Penalty(1_000), 5_000);
    s.set_time(START + 10 * WEEK - 1);
    assert_eq!(s.contract.preview_withdraw(&id).penalty, 500);
    s.set_time(START + 10 * WEEK);
    assert_eq!(s.contract.preview_withdraw(&id).penalty, 0);
    assert_eq!(s.contract.withdraw(&s.owner, &id).to_user, 4_900);
}

#[test]
fn lock_rule_refuses_early_withdrawal() {
    let (s, id) = with_fees(WithdrawalRule::Lock, 5_000);
    assert_eq!(s.contract.try_preview_withdraw(&id), Err(Ok(Error::Locked)));
    assert_eq!(
        s.contract.try_withdraw(&s.owner, &id),
        Err(Ok(Error::Locked))
    );
    assert_eq!(s.contract.goal(&id).principal, 5_000);
}

#[test]
fn lock_rule_releases_at_deadline() {
    let (s, id) = with_fees(WithdrawalRule::Lock, 5_000);
    s.set_time(START + 10 * WEEK);
    assert_eq!(s.contract.withdraw(&s.owner, &id).to_user, 4_900);
    assert_closed(&s, id);
}

#[test]
fn lock_rule_releases_at_target() {
    let (s, id) = with_fees(WithdrawalRule::Lock, 10_000);
    assert_eq!(s.contract.withdraw(&s.owner, &id).to_user, 9_800);
}

#[test]
fn empty_goal_closes_with_no_transfers_even_when_locked() {
    let (s, id) = with_fees(WithdrawalRule::Lock, 0);
    let zero = Withdrawal {
        amount: 0,
        penalty: 0,
        loktin_fee: 0,
        integrator_fee: 0,
        to_user: 0,
    };
    assert_eq!(s.contract.preview_withdraw(&id), zero);
    assert_eq!(s.contract.withdraw(&s.owner, &id), zero);
    // Only this contract's own events: no token transfer happened.
    assert_eq!(s.env.events().all().events().len(), 2);
    assert_closed(&s, id);
}

#[test]
fn zero_transfers_are_skipped() {
    // 0% fees and no penalty: only the owner is paid.
    let s = common::setup();
    s.mint(&s.owner, 10_000);
    let id = s.create_default(WithdrawalRule::Penalty(1_000));
    s.contract.deposit(&s.owner, &id, &10_000);
    s.contract.withdraw(&s.owner, &id);
    // Withdrawn, goal_closed and one token transfer event.
    assert_eq!(s.env.events().all().events().len(), 3);
    assert_eq!(s.token.balance(&s.owner), 10_000);
}

#[test]
fn rounding_favours_the_owner() {
    let (s, id) = with_fees(WithdrawalRule::Penalty(999), 999);
    let w = s.contract.withdraw(&s.owner, &id);
    assert_eq!(
        w,
        Withdrawal {
            amount: 999,
            penalty: 99,
            loktin_fee: 9,
            integrator_fee: 9,
            to_user: 882,
        }
    );
}

#[test]
fn loktin_fee_goes_to_current_recipient() {
    let (s, id) = with_fees(WithdrawalRule::Penalty(0), 5_000);
    let new_recipient = Address::generate(&s.env);
    s.contract.set_fee_recipient(&new_recipient, &s.fee_admin);
    s.contract.withdraw(&s.owner, &id);
    assert_eq!(s.token.balance(&new_recipient), 50);
    assert_eq!(s.token.balance(&s.fee_recipient), 0);
}

#[test]
fn withdraw_rejects_unknown_goal() {
    let s = common::setup();
    assert_eq!(
        s.contract.try_withdraw(&s.owner, &3),
        Err(Ok(Error::GoalNotFound))
    );
}

#[test]
fn withdraw_rejects_someone_else_s_goal() {
    let (s, id) = with_fees(WithdrawalRule::Penalty(0), 5_000);
    let other = Address::generate(&s.env);
    assert_eq!(
        s.contract.try_withdraw(&other, &id),
        Err(Ok(Error::NotOwner))
    );
    assert_eq!(s.contract.goal(&id).principal, 5_000);
}

#[test]
fn removes_only_the_closed_goal_from_the_owner_list() {
    let s = common::setup();
    let first = s.create_default(WithdrawalRule::Lock);
    let second = s.create_default(WithdrawalRule::Lock);
    let third = s.create_default(WithdrawalRule::Lock);
    s.contract.withdraw(&s.owner, &second);
    let ids: std::vec::Vec<u64> = s
        .contract
        .user_goals(&s.owner)
        .iter()
        .map(|g| g.id)
        .collect();
    assert_eq!(ids, [first, third]);
}
