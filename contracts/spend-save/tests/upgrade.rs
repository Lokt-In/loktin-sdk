//! T6: only the upgrader can upgrade, records stay readable, and `upgraded`
//! is emitted. Uses the Wasm built by `stellar contract build`.

mod common;

use loktin_spend_save::Upgraded;
use soroban_sdk::testutils::{
    Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _, MockAuth, MockAuthInvoke,
};
use soroban_sdk::xdr::{ScErrorCode, ScErrorType};
use soroban_sdk::{Address, Event as _, IntoVal, Symbol, Val, Vec};

const WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/wasm32v1-none/release/loktin_spend_save.wasm"
));

const UNAUTHORIZED: u32 = 2000;

#[test]
fn spend_save_upgrader_upgrades_and_records_stay_readable() {
    let s = common::setup();
    s.mint(&s.user, 10_000);
    s.enroll_default();
    s.contract.save_for_spend(&s.user, &s.integrator, &10_000);
    let before = s.contract.enrollment(&s.user, &s.integrator);

    let hash = s.env.deployer().upload_contract_wasm(WASM);
    s.contract.upgrade(&hash, &s.upgrader);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.contract.address),
        [Upgraded {
            new_wasm_hash: hash.clone(),
            operator: s.upgrader.clone(),
        }
        .to_xdr(&s.env, &s.contract.address)]
    );

    // Now running the compiled Wasm.
    assert_eq!(s.contract.enrollment(&s.user, &s.integrator), before);
    s.contract.save_for_spend(&s.user, &s.integrator, &1_000);
    assert_eq!(s.principal(), 1_100);
    assert_eq!(
        s.contract.withdraw(&s.user, &s.integrator, &1_100).to_user,
        1_100
    );
}

#[test]
fn spend_save_upgrade_is_authorized_by_the_upgrader() {
    let s = common::setup_with_fee(0);
    let hash = s.env.deployer().upload_contract_wasm(WASM);
    let args: Vec<Val> = (&hash, &s.upgrader).into_val(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &s.upgrader,
        invoke: &MockAuthInvoke {
            contract: &s.contract.address,
            fn_name: "upgrade",
            args: args.clone(),
            sub_invokes: &[],
        },
    }]);
    s.contract.upgrade(&hash, &s.upgrader);
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.upgrader.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    s.contract.address.clone(),
                    Symbol::new(&s.env, "upgrade"),
                    args,
                )),
                sub_invocations: std::vec![],
            }
        )]
    );
}

#[test]
fn spend_save_everyone_but_the_upgrader_is_refused() {
    let s = common::setup_with_fee(0);
    let hash = s.env.deployer().upload_contract_wasm(WASM);
    let stranger = Address::generate(&s.env);
    for caller in [&stranger, &s.admin, &s.fee_admin, &s.pauser] {
        s.env.mock_auths(&[MockAuth {
            address: caller,
            invoke: &MockAuthInvoke {
                contract: &s.contract.address,
                fn_name: "upgrade",
                args: (&hash, caller).into_val(&s.env),
                sub_invokes: &[],
            },
        }]);
        assert_eq!(
            s.contract.try_upgrade(&hash, caller),
            Err(Ok(soroban_sdk::Error::from_contract_error(UNAUTHORIZED)))
        );
    }
    s.env.mock_auths(&[]);
    assert_eq!(
        s.contract.try_upgrade(&hash, &s.upgrader),
        Err(Ok(soroban_sdk::Error::from_type_and_code(
            ScErrorType::Context,
            ScErrorCode::InvalidAction
        )))
    );
}
