mod common;

use common::{START, WEEK};
use loktin_target_savings::{DepositKind, Deposited, Error, WithdrawalRule};
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{Address, Event as _};

#[test]
fn deposits_and_emits_event() {
    let s = common::setup();
    s.mint(&s.owner, 10_000);
    let id = s.create_default(WithdrawalRule::Lock);
    s.contract.deposit(&s.owner, &id, &2_500);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.contract.address),
        [Deposited {
            goal_id: id,
            owner: s.owner.clone(),
            kind: DepositKind::Manual,
            amount: 2_500,
            principal: 2_500,
        }
        .to_xdr(&s.env, &s.contract.address)]
    );
    let goal = s.contract.goal(&id);
    assert_eq!(goal.principal, 2_500);
    assert_eq!(goal.shares, 2_500);
    assert_eq!(s.token.balance(&s.owner), 7_500);
    assert_eq!(s.token.balance(&s.contract.address), 2_500);
}

#[test]
fn deposit_exactly_what_is_needed_is_accepted() {
    let s = common::setup();
    s.mint(&s.owner, 10_000);
    let id = s.create_default(WithdrawalRule::Lock);
    s.contract.deposit(&s.owner, &id, &4_000);
    s.contract.deposit(&s.owner, &id, &6_000);
    assert_eq!(s.contract.goal(&id).principal, 10_000);
}

#[test]
fn deposit_one_unit_above_what_is_needed_is_rejected() {
    let s = common::setup();
    s.mint(&s.owner, 20_000);
    let id = s.create_default(WithdrawalRule::Lock);
    s.contract.deposit(&s.owner, &id, &4_000);
    assert_eq!(
        s.contract.try_deposit(&s.owner, &id, &6_001),
        Err(Ok(Error::ExceedsTarget))
    );
    s.contract.deposit(&s.owner, &id, &6_000);
    assert_eq!(
        s.contract.try_deposit(&s.owner, &id, &1),
        Err(Ok(Error::ExceedsTarget))
    );
    assert_eq!(s.contract.goal(&id).principal, 10_000);
}

#[test]
fn rejects_amount_not_above_zero() {
    let s = common::setup();
    let id = s.create_default(WithdrawalRule::Lock);
    for amount in [0, -1] {
        assert_eq!(
            s.contract.try_deposit(&s.owner, &id, &amount),
            Err(Ok(Error::InvalidDeposit))
        );
    }
}

#[test]
fn deposit_at_deadline_is_accepted_and_after_is_rejected() {
    let s = common::setup();
    s.mint(&s.owner, 10_000);
    let id = s.create_default(WithdrawalRule::Lock);
    s.set_time(START + 10 * WEEK);
    s.contract.deposit(&s.owner, &id, &1);
    s.set_time(START + 10 * WEEK + 1);
    assert_eq!(
        s.contract.try_deposit(&s.owner, &id, &1),
        Err(Ok(Error::DeadlinePassed))
    );
}

#[test]
fn deposit_rejects_unknown_goal() {
    let s = common::setup();
    assert_eq!(
        s.contract.try_deposit(&s.owner, &7, &1),
        Err(Ok(Error::GoalNotFound))
    );
}

#[test]
fn deposit_rejects_someone_else_s_goal() {
    let s = common::setup();
    let id = s.create_default(WithdrawalRule::Lock);
    let other = Address::generate(&s.env);
    s.mint(&other, 1_000);
    assert_eq!(
        s.contract.try_deposit(&other, &id, &1),
        Err(Ok(Error::NotOwner))
    );
}
