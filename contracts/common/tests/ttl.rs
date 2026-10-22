use loktin_common::ttl::{extend_instance, extend_persistent, TTL_THRESHOLD};
use soroban_sdk::testutils::storage::{Instance as _, Persistent as _};
use soroban_sdk::testutils::Ledger as _;
use soroban_sdk::{contract, symbol_short, Address, Env};

const MAX_ENTRY_TTL: u32 = 3_110_400;

// A contract with no functions, used only to give the helpers storage to work on.
#[contract]
struct TestContract;

fn setup() -> (Env, Address) {
    let env = Env::default();
    env.ledger().with_mut(|li| {
        li.sequence_number = 1_000;
        li.min_persistent_entry_ttl = 4_096;
        li.min_temp_entry_ttl = 16;
        li.max_entry_ttl = MAX_ENTRY_TTL;
    });
    let id = env.register(TestContract, ());
    (env, id)
}

#[test]
fn threshold_value() {
    assert_eq!(TTL_THRESHOLD, 518_400);
}

#[test]
fn extend_instance_below_threshold_extends_to_max() {
    let (env, id) = setup();
    env.as_contract(&id, || {
        assert!(env.storage().instance().get_ttl() < TTL_THRESHOLD);
        extend_instance(&env);
        assert_eq!(env.storage().instance().get_ttl(), env.storage().max_ttl());
    });
}

#[test]
fn extend_instance_above_threshold_does_nothing() {
    let (env, id) = setup();
    env.as_contract(&id, || extend_instance(&env));
    env.ledger().with_mut(|li| li.sequence_number += 10);
    env.as_contract(&id, || {
        let before = env.storage().instance().get_ttl();
        assert!(before >= TTL_THRESHOLD);
        extend_instance(&env);
        assert_eq!(env.storage().instance().get_ttl(), before);
    });
}

#[test]
fn extend_persistent_below_threshold_extends_to_max() {
    let (env, id) = setup();
    let key = symbol_short!("key");
    env.as_contract(&id, || {
        env.storage().persistent().set(&key, &1_u32);
        assert!(env.storage().persistent().get_ttl(&key) < TTL_THRESHOLD);
        extend_persistent(&env, &key);
        assert_eq!(
            env.storage().persistent().get_ttl(&key),
            env.storage().max_ttl()
        );
    });
}

#[test]
fn extend_persistent_above_threshold_does_nothing() {
    let (env, id) = setup();
    let key = symbol_short!("key");
    env.as_contract(&id, || {
        env.storage().persistent().set(&key, &1_u32);
        extend_persistent(&env, &key);
    });
    env.ledger().with_mut(|li| li.sequence_number += 10);
    env.as_contract(&id, || {
        let before = env.storage().persistent().get_ttl(&key);
        assert!(before >= TTL_THRESHOLD);
        extend_persistent(&env, &key);
        assert_eq!(env.storage().persistent().get_ttl(&key), before);
    });
}
