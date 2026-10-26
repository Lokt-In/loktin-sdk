//! C5: the 0.2.0 upgrade keeps every record. The released 0.1.0 Wasm
//! creates real state, the upgrader replaces it with the newly built Wasm,
//! and the old records read back unchanged. Needs `stellar contract build`
//! first, like `upgrade.rs`.

mod common;

use common::{percent, START, TODAY};
use loktin_spend_save::{Destination, SpendSaveClient, Upgraded, Withdrawal};
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{Address, Bytes, Env, Event as _};

/// The `contracts-v0.1.0` release build, as deployed on testnet.
const OLD_WASM: &[u8] = include_bytes!("fixtures/loktin_spend_save_0_1_0.wasm");
const OLD_SHA256: &str = "1e655573744740bfbbebbb04b7c54c9058e979c853bc23fe4f71431cc3999183";

const NEW_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/wasm32v1-none/release/loktin_spend_save.wasm"
));

fn sha256_hex(env: &Env, wasm: &[u8]) -> String {
    env.crypto()
        .sha256(&Bytes::from_slice(env, wasm))
        .to_array()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[test]
fn fixture_is_the_released_0_1_0_wasm() {
    let env = Env::default();
    assert_eq!(sha256_hex(&env, OLD_WASM), OLD_SHA256);
}

#[test]
fn upgrade_from_0_1_0_keeps_records_and_accrues_fees() {
    let env = common::env();
    env.mock_all_auths();
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let token = TokenClient::new(&env, &sac.address());
    let asset = StellarAssetClient::new(&env, &sac.address());
    let [admin, fee_admin, pauser, upgrader, fee_recipient, user, integrator] =
        core::array::from_fn(|_| Address::generate(&env));

    // State created by the 0.1.0 code: an enrolment with two saves to the
    // balance, on an instance charging 1% with no Target Savings link.
    let id = env.register(
        OLD_WASM,
        (
            admin,
            fee_admin,
            pauser,
            upgrader.clone(),
            sac.address(),
            fee_recipient.clone(),
            100_u32,
            None::<Address>,
            None::<Address>,
        ),
    );
    let contract = SpendSaveClient::new(&env, &id);
    asset.mint(&user, &50_000);
    contract.enroll(
        &user,
        &integrator,
        &100,
        &percent(1_000),
        &Some(5_000),
        &Destination::Balance,
        &TODAY,
    );
    contract.save_for_spend(&user, &integrator, &10_000);
    contract.save_for_spend(&user, &integrator, &20_000);

    let enrollment = contract.enrollment(&user, &integrator);
    assert_eq!(enrollment.principal, 3_000);
    assert_eq!(enrollment.total_spent, 30_000);
    let preview = contract.preview_skim(&user, &integrator, &1_000);
    let window = contract.next_window(&user, &integrator);
    assert_eq!(window.0, START);
    let loktin_fee_bps = contract.loktin_fee_bps();

    // The 0.1.0 code has no accrued fees.
    assert!(contract.try_accrued_fees(&integrator).is_err());

    let hash = env.deployer().upload_contract_wasm(NEW_WASM);
    contract.upgrade(&hash, &upgrader);
    assert_eq!(
        env.events().all().filter_by_contract(&id),
        [Upgraded {
            new_wasm_hash: hash,
            operator: upgrader,
        }
        .to_xdr(&env, &id)]
    );

    // Every old record reads back unchanged under the new code.
    assert_eq!(contract.enrollment(&user, &integrator), enrollment);
    assert_eq!(contract.preview_skim(&user, &integrator, &1_000), preview);
    assert_eq!(contract.next_window(&user, &integrator), window);
    assert_eq!(contract.token(), sac.address());
    assert_eq!(contract.fee_recipient(), fee_recipient);
    assert_eq!(contract.target_savings(), None);
    assert_eq!(contract.loktin_fee_bps(), loktin_fee_bps);
    assert!(!contract.paused());

    // A withdrawal now pays only the user, and the fees accrue.
    let expected = Withdrawal {
        amount: 2_000,
        loktin_fee: 20,
        integrator_fee: 20,
        to_user: 1_960,
    };
    assert_eq!(contract.withdraw(&user, &integrator, &2_000), expected);
    assert_eq!(token.balance(&user), 47_000 + 1_960);
    assert_eq!(token.balance(&integrator), 0);
    assert_eq!(token.balance(&fee_recipient), 0);
    assert_eq!(contract.accrued_fees(&integrator), 20);
    assert_eq!(contract.accrued_fees(&fee_recipient), 20);
    assert_eq!(token.balance(&id), 1_000 + 40);

    assert_eq!(contract.claim_fees(&integrator), 20);
    assert_eq!(contract.claim_fees(&fee_recipient), 20);
    assert_eq!(token.balance(&integrator), 20);
    assert_eq!(token.balance(&fee_recipient), 20);
    assert_eq!(token.balance(&id), 1_000);
}
