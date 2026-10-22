mod common;

use common::env;
use loktin_common::roles;
use loktin_spend_save::{Error, SpendSave};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env};

fn register(env: &Env, loktin_fee_bps: u32, yield_source: Option<Address>) {
    let token = env.register_stellar_asset_contract_v2(Address::generate(env));
    env.register(
        SpendSave,
        (
            Address::generate(env),
            Address::generate(env),
            Address::generate(env),
            Address::generate(env),
            token.address(),
            Address::generate(env),
            loktin_fee_bps,
            None::<Address>,
            yield_source,
        ),
    );
}

#[test]
fn constructor_sets_configuration_and_roles() {
    let s = common::setup_with_fee(100);
    let c = &s.contract;
    assert_eq!(c.token(), s.token.address);
    assert_eq!(c.fee_recipient(), s.fee_recipient);
    assert_eq!(c.loktin_fee_bps(), 100);
    assert_eq!(c.target_savings(), Some(s.savings.address.clone()));
    assert_eq!(c.get_admin(), Some(s.admin.clone()));
    assert_eq!(c.has_role(&s.fee_admin, &roles::FEE_ADMIN), Some(0));
    assert_eq!(c.has_role(&s.pauser, &roles::PAUSER), Some(0));
    assert_eq!(c.has_role(&s.upgrader, &roles::UPGRADER), Some(0));
    assert!(!c.paused());
}

#[test]
fn constructor_accepts_no_target_savings() {
    let s = common::setup_in(env(), 0, false);
    assert_eq!(s.contract.target_savings(), None);
}

#[test]
fn constructor_accepts_fee_at_cap() {
    register(&env(), 100, None);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn constructor_rejects_fee_above_cap() {
    register(&env(), 101, None);
}

#[test]
#[should_panic(expected = "Error(Contract, #213)")]
fn constructor_rejects_any_yield_source() {
    let env = env();
    let source = Address::generate(&env);
    register(&env, 0, Some(source));
}

#[test]
#[should_panic(expected = "Error(Contract, #210)")]
fn constructor_rejects_this_contract_as_fee_recipient() {
    let env = env();
    let token = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let id = Address::generate(&env);
    env.register_at(
        &id,
        SpendSave,
        (
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
            token.address(),
            id.clone(),
            0_u32,
            None::<Address>,
            None::<Address>,
        ),
    );
}

#[test]
fn error_codes_mirror_common_errors() {
    use loktin_common::CommonError;
    for (common, ours) in [
        (CommonError::InvalidAmount, Error::InvalidAmount),
        (CommonError::Overflow, Error::Overflow),
        (CommonError::RateAboveCap, Error::RateAboveCap),
        (CommonError::InvalidDay, Error::InvalidDay),
        (CommonError::InvalidCadence, Error::InvalidCadence),
    ] {
        assert_eq!(common.code(), ours as u32);
        assert_eq!(Error::from(common), ours);
    }
}
