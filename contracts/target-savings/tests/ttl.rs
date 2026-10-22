//! T5: touched entries are extended, and an archived goal is restored.

mod common;

use common::{Setup, START, WEEK};
use loktin_common::ttl::TTL_THRESHOLD;
use loktin_target_savings::{DataKey, WithdrawalRule};
use soroban_sdk::testutils::storage::{Instance as _, Persistent as _};

fn instance_ttl(s: &Setup) -> u32 {
    s.env
        .as_contract(&s.contract.address, || s.env.storage().instance().get_ttl())
}

fn entry_ttl(s: &Setup, key: &DataKey) -> u32 {
    s.env.as_contract(&s.contract.address, || {
        s.env.storage().persistent().get_ttl(key)
    })
}

fn max_ttl(s: &Setup) -> u32 {
    s.env
        .as_contract(&s.contract.address, || s.env.storage().max_ttl())
}

/// Moves the ledger forward so an entry at maximum TTL drops just below the
/// renewal threshold.
fn age_below_threshold(s: &Setup) {
    s.advance_ledgers(max_ttl(s) - TTL_THRESHOLD + 1);
}

#[test]
fn create_extends_instance_goal_and_owner_list_to_maximum() {
    let s = common::setup();
    let id = s.create_default(WithdrawalRule::Lock);
    let max = max_ttl(&s);
    assert_eq!(instance_ttl(&s), max);
    assert_eq!(entry_ttl(&s, &DataKey::Goal(id)), max);
    assert_eq!(entry_ttl(&s, &DataKey::UserGoals(s.owner.clone())), max);
}

#[test]
fn entries_above_threshold_are_left_alone() {
    let s = common::setup();
    s.mint(&s.owner, 1_000);
    let id = s.create_default(WithdrawalRule::Lock);
    s.advance_ledgers(100);
    let before = entry_ttl(&s, &DataKey::Goal(id));
    s.contract.deposit(&s.owner, &id, &1);
    assert_eq!(entry_ttl(&s, &DataKey::Goal(id)), before);
}

#[test]
fn deposit_renews_the_goal_and_instance_below_threshold() {
    let s = common::setup();
    s.mint(&s.owner, 1_000);
    let id = s.create_default(WithdrawalRule::Lock);
    age_below_threshold(&s);
    assert!(entry_ttl(&s, &DataKey::Goal(id)) < TTL_THRESHOLD);
    assert!(instance_ttl(&s) < TTL_THRESHOLD);
    s.contract.deposit(&s.owner, &id, &1);
    assert_eq!(entry_ttl(&s, &DataKey::Goal(id)), max_ttl(&s));
    assert_eq!(instance_ttl(&s), max_ttl(&s));
}

#[test]
fn collect_renews_only_the_goal_it_touches() {
    let s = common::setup();
    s.mint(&s.owner, 10_000);
    let allowance = s.allowance(10_000);
    let touched = s.contract.create_goal(
        &s.owner,
        &10_000,
        &(START + 10 * WEEK),
        &WEEK,
        &1_000,
        &WithdrawalRule::Lock,
        &s.integrator,
        &0,
        &allowance,
    );
    let untouched = s.create_default(WithdrawalRule::Lock);
    age_below_threshold(&s);
    s.set_time(START + WEEK);
    s.contract.collect(&touched);
    assert_eq!(entry_ttl(&s, &DataKey::Goal(touched)), max_ttl(&s));
    assert!(entry_ttl(&s, &DataKey::Goal(untouched)) < TTL_THRESHOLD);
    assert_eq!(instance_ttl(&s), max_ttl(&s));
}

#[test]
fn withdraw_renews_the_owner_list_and_instance() {
    let s = common::setup();
    let closed = s.create_default(WithdrawalRule::Lock);
    s.create_default(WithdrawalRule::Lock);
    age_below_threshold(&s);
    s.contract.withdraw(&s.owner, &closed);
    assert_eq!(
        entry_ttl(&s, &DataKey::UserGoals(s.owner.clone())),
        max_ttl(&s)
    );
    assert_eq!(instance_ttl(&s), max_ttl(&s));
}

#[test]
fn role_and_fee_functions_renew_the_instance() {
    let s = common::setup();
    age_below_threshold(&s);
    s.contract.set_loktin_fee(&1, &s.fee_admin);
    assert_eq!(instance_ttl(&s), max_ttl(&s));
    age_below_threshold(&s);
    s.contract.pause(&s.pauser);
    assert_eq!(instance_ttl(&s), max_ttl(&s));
}

#[test]
fn archived_goal_is_restored_and_usable() {
    let s = common::setup();
    s.mint(&s.owner, 1_000);
    let id = s.create_default(WithdrawalRule::Lock);
    let live_until = s.env.ledger().sequence() + entry_ttl(&s, &DataKey::Goal(id));
    // Move past the goal's last live ledger: the entry is archived.
    s.advance_ledgers(entry_ttl(&s, &DataKey::Goal(id)) + 1);
    assert!(s.env.ledger().sequence() > live_until);
    // The next call restores it automatically, as simulation does on the
    // network since protocol 23, and the goal is intact.
    assert_eq!(s.contract.goal(&id).id, id);
    s.contract.deposit(&s.owner, &id, &1);
    assert_eq!(s.contract.goal(&id).principal, 1);
    assert_eq!(entry_ttl(&s, &DataKey::Goal(id)), max_ttl(&s));
}
