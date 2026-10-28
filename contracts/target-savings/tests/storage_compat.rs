//! C5: upgrades keep every record. A released Wasm (0.1.0 or 0.2.0) creates
//! real state, the upgrader replaces it with the newly built Wasm, and the
//! old records read back unchanged. Needs `stellar contract build` first,
//! like `upgrade.rs`.

mod common;

use common::{MIN_CADENCE, START, WEEK};
use loktin_target_savings::{TargetSavingsClient, Upgraded, Withdrawal, WithdrawalRule};
use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{Address, Bytes, Env, Event as _};

/// The `contracts-v0.1.0` release build, as deployed on testnet.
const OLD_WASM: &[u8] = include_bytes!("fixtures/loktin_target_savings_0_1_0.wasm");
const OLD_SHA256: &str = "5b67b75f7504bb748e7b4c891cbf956d381d923431c591a2e6bde072d50d047e";

/// The `contracts-v0.2.0` release build, as deployed on testnet.
const WASM_0_2_0: &[u8] = include_bytes!("fixtures/loktin_target_savings_0_2_0.wasm");
const SHA256_0_2_0: &str = "9686da20b05d891a317272f92fce0fb2e9d75fa7f67ec5934452be827fe9a0a9";

const NEW_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/wasm32v1-none/release/loktin_target_savings.wasm"
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
    let [admin, fee_admin, pauser, upgrader, fee_recipient, owner, integrator] =
        core::array::from_fn(|_| Address::generate(&env));

    // State created by the 0.1.0 code: a goal with a manual deposit and one
    // scheduled collection, on an instance charging 1%.
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
            MIN_CADENCE,
            None::<Address>,
        ),
    );
    let contract = TargetSavingsClient::new(&env, &id);
    asset.mint(&owner, &10_000);
    let goal_id = contract.create_goal(
        &owner,
        &10_000,
        &(START + 10 * WEEK),
        &WEEK,
        &1_000,
        &WithdrawalRule::Penalty(1_000),
        &integrator,
        &100,
        &Some((10_000, env.ledger().sequence() + common::MAX_ENTRY_TTL - 1)),
    );
    contract.deposit(&owner, &goal_id, &2_000);
    env.ledger().with_mut(|li| li.timestamp = START + WEEK);
    contract.collect(&goal_id);

    let goal = contract.goal(&goal_id);
    assert_eq!(goal.principal, 3_000);
    assert_eq!(goal.last_collected_period, 1);
    let user_goals = contract.user_goals(&owner);
    let min_cadence = contract.min_cadence();
    let loktin_fee_bps = contract.loktin_fee_bps();
    let preview = contract.preview_withdraw(&goal_id);

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
    assert_eq!(contract.goal(&goal_id), goal);
    assert_eq!(contract.user_goals(&owner), user_goals);
    assert_eq!(contract.token(), sac.address());
    assert_eq!(contract.fee_recipient(), fee_recipient);
    assert_eq!(contract.min_cadence(), min_cadence);
    assert_eq!(contract.loktin_fee_bps(), loktin_fee_bps);
    assert!(!contract.paused());
    assert_eq!(contract.preview_withdraw(&goal_id), preview);

    // A withdrawal now pays only the owner, and the fees accrue.
    let expected = Withdrawal {
        amount: 3_000,
        penalty: 300,
        loktin_fee: 30,
        integrator_fee: 30,
        to_user: 2_640,
    };
    assert_eq!(contract.withdraw(&owner, &goal_id), expected);
    assert_eq!(token.balance(&owner), 7_000 + 2_640);
    assert_eq!(token.balance(&integrator), 0);
    assert_eq!(token.balance(&fee_recipient), 0);
    assert_eq!(contract.accrued_fees(&integrator), 330);
    assert_eq!(contract.accrued_fees(&fee_recipient), 30);

    assert_eq!(contract.claim_fees(&integrator), 330);
    assert_eq!(contract.claim_fees(&fee_recipient), 30);
    assert_eq!(token.balance(&integrator), 330);
    assert_eq!(token.balance(&fee_recipient), 30);
    assert_eq!(token.balance(&id), 0);
}

#[test]
fn fixture_is_the_released_0_2_0_wasm() {
    let env = Env::default();
    assert_eq!(sha256_hex(&env, WASM_0_2_0), SHA256_0_2_0);
}

#[test]
fn upgrade_from_0_2_0_keeps_sequential_goals_and_moves_to_owner_ids() {
    let env = common::env();
    env.mock_all_auths();
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let token = TokenClient::new(&env, &sac.address());
    let asset = StellarAssetClient::new(&env, &sac.address());
    let [admin, fee_admin, pauser, upgrader, fee_recipient, owner, integrator] =
        core::array::from_fn(|_| Address::generate(&env));

    // State created by the 0.2.0 code: three goals with sequential ids,
    // a manual deposit and a scheduled collection.
    let id = env.register(
        WASM_0_2_0,
        (
            admin,
            fee_admin,
            pauser,
            upgrader.clone(),
            sac.address(),
            fee_recipient.clone(),
            100_u32,
            MIN_CADENCE,
            None::<Address>,
        ),
    );
    let contract = TargetSavingsClient::new(&env, &id);
    asset.mint(&owner, &100_000);
    let allowance = Some((100_000, env.ledger().sequence() + common::MAX_ENTRY_TTL - 1));
    let create = |rule: WithdrawalRule| {
        contract.create_goal(
            &owner,
            &10_000,
            &(START + 10 * WEEK),
            &WEEK,
            &1_000,
            &rule,
            &integrator,
            &100,
            &allowance,
        )
    };
    let old_ids = [
        create(WithdrawalRule::Penalty(1_000)),
        create(WithdrawalRule::Lock),
        create(WithdrawalRule::Penalty(500)),
    ];
    assert_eq!(old_ids, [1, 2, 3]);
    contract.deposit(&owner, &1, &2_000);
    env.ledger().with_mut(|li| li.timestamp = START + WEEK);
    contract.collect(&1);
    let before: std::vec::Vec<_> = old_ids.iter().map(|id| contract.goal(id)).collect();
    assert_eq!(before[0].principal, 3_000);

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

    // The old goals read back unchanged, and collect and withdraw as before.
    for (goal_id, goal) in old_ids.iter().zip(&before) {
        assert_eq!(&contract.goal(goal_id), goal);
    }
    env.ledger().with_mut(|li| li.timestamp = START + 2 * WEEK);
    contract.collect(&1);
    contract.collect(&2);
    assert_eq!(contract.goal(&1).principal, 4_000);
    assert_eq!(contract.goal(&1).last_collected_period, 2);
    assert_eq!(contract.goal(&2).principal, 1_000);
    assert_eq!(contract.goal(&2).missed_count, 1);
    // Early, with a 10% penalty, 1% integrator fee and 1% Loktin fee.
    let withdrawn = contract.withdraw(&owner, &1);
    assert_eq!(withdrawn.amount, 4_000);
    assert_eq!(withdrawn.penalty, 400);
    assert_eq!(withdrawn.to_user, 3_520);
    assert_eq!(contract.accrued_fees(&integrator), 440);
    assert_eq!(contract.accrued_fees(&fee_recipient), 40);

    // New goals get owner ids, which never meet the old sequential ones.
    let new_ids = [create(WithdrawalRule::Lock), create(WithdrawalRule::Lock)];
    assert_eq!(
        new_ids,
        [
            common::goal_id(&env, &owner, 0),
            common::goal_id(&env, &owner, 1)
        ]
    );
    assert!(new_ids.iter().all(|id| !old_ids.contains(id)));

    // `user_goals` lists both kinds, oldest first.
    let listed: std::vec::Vec<u64> = contract.user_goals(&owner).iter().map(|g| g.id).collect();
    assert_eq!(listed, [2, 3, new_ids[0], new_ids[1]]);
    assert_eq!(token.balance(&id), 1_000 + 440 + 40);
}
