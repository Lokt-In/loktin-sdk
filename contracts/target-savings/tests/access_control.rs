//! OpenZeppelin access control, exposed unchanged (C2).

mod common;

use loktin_common::roles;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Symbol};

#[test]
fn admin_grants_and_revokes_roles() {
    let s = common::setup();
    let c = &s.contract;
    let second_pauser = Address::generate(&s.env);
    c.grant_role(&second_pauser, &roles::PAUSER, &s.admin);
    assert_eq!(c.has_role(&second_pauser, &roles::PAUSER), Some(1));
    assert_eq!(c.get_role_member_count(&roles::PAUSER), 2);
    assert_eq!(c.get_role_member(&roles::PAUSER, &1), second_pauser);
    c.pause(&second_pauser);
    c.unpause(&second_pauser);
    c.revoke_role(&second_pauser, &roles::PAUSER, &s.admin);
    assert_eq!(c.has_role(&second_pauser, &roles::PAUSER), None);
    assert_eq!(c.get_role_member_count(&roles::PAUSER), 1);
}

#[test]
fn lists_roles_and_role_admins() {
    let s = common::setup();
    let c = &s.contract;
    let roles_now = c.get_existing_roles();
    assert_eq!(roles_now.len(), 3);
    assert!(roles_now.contains(roles::FEE_ADMIN));
    assert!(roles_now.contains(roles::PAUSER));
    assert!(roles_now.contains(roles::UPGRADER));
    assert_eq!(c.get_role_admin(&roles::PAUSER), None);
    let pauser_admin = Symbol::new(&s.env, "pauser_admin");
    c.set_role_admin(&roles::PAUSER, &pauser_admin);
    assert_eq!(c.get_role_admin(&roles::PAUSER), Some(pauser_admin));
}

#[test]
fn role_holder_can_renounce() {
    let s = common::setup();
    s.contract.renounce_role(&roles::PAUSER, &s.pauser);
    assert_eq!(s.contract.has_role(&s.pauser, &roles::PAUSER), None);
}

#[test]
fn admin_transfer_is_two_step() {
    let s = common::setup();
    let new_admin = Address::generate(&s.env);
    let live_until = s.env.ledger().sequence() + 100;
    s.contract.transfer_admin_role(&new_admin, &live_until);
    assert_eq!(s.contract.get_admin(), Some(s.admin.clone()));
    s.contract.accept_admin_transfer();
    assert_eq!(s.contract.get_admin(), Some(new_admin));
}

#[test]
fn admin_can_renounce() {
    let s = common::setup();
    s.contract.renounce_admin();
    assert_eq!(s.contract.get_admin(), None);
}
