//! T6: only the upgrader can upgrade, records stay readable, and `upgraded`
//! is emitted. Uses the Wasm built by `stellar contract build`.

mod common;

use loktin_target_savings::{Upgraded, WithdrawalRule};
use soroban_sdk::testutils::{
    Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _, MockAuth, MockAuthInvoke,
};
use soroban_sdk::xdr::{ScErrorCode, ScErrorType};
use soroban_sdk::{Address, Event as _, IntoVal, Symbol, Val, Vec};

const WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/wasm32v1-none/release/loktin_target_savings.wasm"
));

const UNAUTHORIZED: u32 = 2000;

#[test]
fn upgrader_upgrades_and_records_stay_readable() {
    let s = common::setup();
    s.mint(&s.owner, 5_000);
    let id = s.create_default(WithdrawalRule::Penalty(500));
    s.contract.deposit(&s.owner, &id, &5_000);
    let before = s.contract.goal(&id);

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
    assert_eq!(s.contract.goal(&id), before);
    assert_eq!(s.contract.user_goals(&s.owner).get_unchecked(0), before);
    assert_eq!(s.contract.next_id(), 2);
    assert_eq!(s.contract.token(), s.token.address);
    assert_eq!(s.contract.withdraw(&s.owner, &id).penalty, 250);
}

#[test]
fn upgrade_is_authorized_by_the_upgrader() {
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
fn everyone_but_the_upgrader_is_refused() {
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
    // The upgrader's address without its signature is refused too.
    s.env.mock_auths(&[]);
    assert_eq!(
        s.contract.try_upgrade(&hash, &s.upgrader),
        Err(Ok(soroban_sdk::Error::from_type_and_code(
            ScErrorType::Context,
            ScErrorCode::InvalidAction
        )))
    );
}
