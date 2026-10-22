//! OpenZeppelin access control, exposed unchanged (C2).

mod common;

use loktin_common::roles;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

#[test]
fn spend_save_admin_grants_and_revokes_roles() {
    let s = common::setup();
    let c = &s.contract;
    let account = Address::generate(&s.env);
    c.grant_role(&account, &roles::PAUSER, &s.admin);
    assert_eq!(c.has_role(&account, &roles::PAUSER), Some(1));
    c.pause(&account);
    c.unpause(&account);
    c.revoke_role(&account, &roles::PAUSER, &s.admin);
    assert_eq!(c.has_role(&account, &roles::PAUSER), None);
    assert_eq!(c.get_existing_roles().len(), 3);
}

#[test]
fn spend_save_admin_transfer_is_two_step() {
    let s = common::setup();
    let new_admin = Address::generate(&s.env);
    let live_until = s.env.ledger().sequence() + 100;
    s.contract.transfer_admin_role(&new_admin, &live_until);
    s.contract.accept_admin_transfer();
    assert_eq!(s.contract.get_admin(), Some(new_admin));
}
