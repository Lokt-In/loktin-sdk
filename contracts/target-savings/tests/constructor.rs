mod common;

use common::{env, MIN_CADENCE};
use loktin_common::roles;
use loktin_target_savings::{Error, TargetSavings};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env};

fn register(env: &Env, loktin_fee_bps: u32, min_cadence: u64, yield_source: Option<Address>) {
    let token = env.register_stellar_asset_contract_v2(Address::generate(env));
    env.register(
        TargetSavings,
        (
            Address::generate(env),
            Address::generate(env),
            Address::generate(env),
            Address::generate(env),
            token.address(),
            Address::generate(env),
            loktin_fee_bps,
            min_cadence,
            yield_source,
        ),
    );
}

#[test]
fn sets_configuration_and_roles() {
    let s = common::setup_with_fee(100);
    let c = &s.contract;
    assert_eq!(c.token(), s.token.address);
    assert_eq!(c.fee_recipient(), s.fee_recipient);
    assert_eq!(c.loktin_fee_bps(), 100);
    assert_eq!(c.min_cadence(), MIN_CADENCE);
    assert_eq!(c.next_id(), 1);
    assert_eq!(c.get_admin(), Some(s.admin.clone()));
    assert_eq!(c.has_role(&s.fee_admin, &roles::FEE_ADMIN), Some(0));
    assert_eq!(c.has_role(&s.pauser, &roles::PAUSER), Some(0));
    assert_eq!(c.has_role(&s.upgrader, &roles::UPGRADER), Some(0));
    assert_eq!(c.has_role(&s.admin, &roles::FEE_ADMIN), None);
    assert!(!c.paused());
}

#[test]
fn accepts_fee_at_cap() {
    register(&env(), 100, MIN_CADENCE, None);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn rejects_fee_above_cap() {
    register(&env(), 101, MIN_CADENCE, None);
}

#[test]
fn accepts_min_cadence_of_one_second() {
    register(&env(), 0, 1, None);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn rejects_min_cadence_zero() {
    register(&env(), 0, 0, None);
}

#[test]
#[should_panic(expected = "Error(Contract, #116)")]
fn rejects_any_yield_source() {
    let env = env();
    let source = Address::generate(&env);
    register(&env, 0, MIN_CADENCE, Some(source));
}

#[test]
#[should_panic(expected = "Error(Contract, #119)")]
fn rejects_this_contract_as_fee_recipient() {
    let env = env();
    let token = env.register_stellar_asset_contract_v2(Address::generate(&env));
    // The address the contract will be registered at.
    let id = Address::generate(&env);
    env.register_at(
        &id,
        TargetSavings,
        (
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
            token.address(),
            id.clone(),
            0_u32,
            MIN_CADENCE,
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
