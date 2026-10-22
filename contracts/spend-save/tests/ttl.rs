//! T5: touched entries are extended, and an archived enrolment is restored.

mod common;

use common::{percent, Setup, TODAY};
use loktin_common::ttl::TTL_THRESHOLD;
use loktin_spend_save::{DataKey, Destination};
use soroban_sdk::testutils::storage::{Instance as _, Persistent as _};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

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

fn enrollment_key(s: &Setup) -> DataKey {
    DataKey::Enrollment(s.user.clone(), s.integrator.clone())
}

fn age_below_threshold(s: &Setup) {
    s.advance_ledgers(max_ttl(s) - TTL_THRESHOLD + 1);
}

#[test]
fn enroll_extends_instance_enrolment_and_user_list_to_maximum() {
    let s = common::setup();
    s.enroll_default();
    let max = max_ttl(&s);
    assert_eq!(instance_ttl(&s), max);
    assert_eq!(entry_ttl(&s, &enrollment_key(&s)), max);
    assert_eq!(
        entry_ttl(&s, &DataKey::UserEnrollments(s.user.clone())),
        max
    );
}

#[test]
fn enrolment_above_threshold_is_left_alone() {
    let s = common::setup();
    s.mint(&s.user, 1_000);
    s.enroll_default();
    s.advance_ledgers(100);
    let before = entry_ttl(&s, &enrollment_key(&s));
    s.contract.save_for_spend(&s.user, &s.integrator, &100);
    assert_eq!(entry_ttl(&s, &enrollment_key(&s)), before);
}

#[test]
fn skim_renews_only_the_enrolment_it_touches() {
    let s = common::setup();
    s.mint(&s.user, 1_000);
    s.enroll_default();
    let other = Address::generate(&s.env);
    s.contract.enroll(
        &s.user,
        &other,
        &0,
        &percent(100),
        &None,
        &Destination::Balance,
        &TODAY,
    );
    age_below_threshold(&s);
    s.contract.save_for_spend(&s.user, &s.integrator, &100);
    assert_eq!(entry_ttl(&s, &enrollment_key(&s)), max_ttl(&s));
    assert!(entry_ttl(&s, &DataKey::Enrollment(s.user.clone(), other)) < TTL_THRESHOLD);
    assert_eq!(instance_ttl(&s), max_ttl(&s));
}

#[test]
fn settings_withdraw_and_close_renew_what_they_touch() {
    let s = common::setup();
    s.mint(&s.user, 1_000);
    s.enroll_default();
    let other = Address::generate(&s.env);
    s.contract.enroll(
        &s.user,
        &other,
        &0,
        &percent(100),
        &None,
        &Destination::Balance,
        &TODAY,
    );
    s.contract.save_for_spend(&s.user, &s.integrator, &1_000);
    age_below_threshold(&s);
    s.contract.update_settings(
        &s.user,
        &s.integrator,
        &percent(200),
        &None,
        &Destination::Balance,
        &TODAY,
    );
    assert_eq!(entry_ttl(&s, &enrollment_key(&s)), max_ttl(&s));
    age_below_threshold(&s);
    s.contract.withdraw(&s.user, &s.integrator, &100);
    assert_eq!(entry_ttl(&s, &enrollment_key(&s)), max_ttl(&s));
    assert_eq!(instance_ttl(&s), max_ttl(&s));
    age_below_threshold(&s);
    s.contract.close(&s.user, &other);
    assert_eq!(
        entry_ttl(&s, &DataKey::UserEnrollments(s.user.clone())),
        max_ttl(&s)
    );
    assert_eq!(instance_ttl(&s), max_ttl(&s));
}

#[test]
fn archived_enrolment_is_restored_and_usable() {
    let s = common::setup();
    s.mint(&s.user, 1_000);
    s.enroll_default();
    let ttl = entry_ttl(&s, &enrollment_key(&s));
    let live_until = s.env.ledger().sequence() + ttl;
    s.advance_ledgers(ttl + 1);
    assert!(s.env.ledger().sequence() > live_until);
    // The next call restores it automatically, as simulation does on the
    // network since protocol 23.
    assert_eq!(s.principal(), 0);
    s.contract.save_for_spend(&s.user, &s.integrator, &1_000);
    assert_eq!(s.principal(), 100);
    assert_eq!(entry_ttl(&s, &enrollment_key(&s)), max_ttl(&s));
}
