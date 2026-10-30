//! T10: the resources of every public function that writes, and of the main
//! reads, each in its worst realistic state, stay under a quarter of
//! testnet's per-transaction limits. Runs the release Wasm built by
//! `stellar contract build`, so VM instantiation, execution and Wasm reads
//! are counted. Auths are mocked, so signature checks are not, and the
//! transaction's own size is not modelled.
//!
//! `cargo test -p loktin-target-savings --test budgets -- --nocapture`
//! prints one line per function.

mod common;

use common::{with_ledger, MAX_ENTRY_TTL, START, WEEK};
use loktin_common::budgets::check;
use loktin_common::measured;
use loktin_target_savings::{TargetSavingsClient, WithdrawalRule};
use soroban_sdk::testutils::{Address as _, EnvTestConfig, Ledger as _};
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{symbol_short, Address, Env};

const WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/wasm32v1-none/release/loktin_target_savings.wasm"
));

/// The highest Loktin and integrator fees, and the highest penalty.
const LOKTIN_FEE_BPS: u32 = 100;
const INTEGRATOR_FEE_BPS: u32 = 100;
const PENALTY_BPS: u32 = 1_000;
const MAX_OPEN_GOALS: u32 = 20;

struct Wasm<'a> {
    env: Env,
    contract: TargetSavingsClient<'a>,
    asset: StellarAssetClient<'a>,
    admin: Address,
    fee_admin: Address,
    pauser: Address,
    upgrader: Address,
    owner: Address,
    integrator: Address,
}

/// The release Wasm with every role held by its own address, the highest
/// Loktin fee, and every auth mocked. No test snapshot is written.
fn setup<'a>() -> Wasm<'a> {
    let env = with_ledger(Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    }));
    env.mock_all_auths();
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let admin = Address::generate(&env);
    let fee_admin = Address::generate(&env);
    let pauser = Address::generate(&env);
    let upgrader = Address::generate(&env);
    let id = env.register(
        WASM,
        (
            admin.clone(),
            fee_admin.clone(),
            pauser.clone(),
            upgrader.clone(),
            sac.address(),
            Address::generate(&env),
            LOKTIN_FEE_BPS,
            common::MIN_CADENCE,
            None::<Address>,
        ),
    );
    Wasm {
        contract: TargetSavingsClient::new(&env, &id),
        asset: StellarAssetClient::new(&env, &sac.address()),
        owner: Address::generate(&env),
        integrator: Address::generate(&env),
        admin,
        fee_admin,
        pauser,
        upgrader,
        env,
    }
}

impl Wasm<'_> {
    fn allowance(&self) -> Option<(i128, u32)> {
        Some((1_000_000, self.env.ledger().sequence() + MAX_ENTRY_TTL - 1))
    }

    /// A weekly goal of 1,000 toward 10,000 in 10 weeks, with the highest
    /// fees and penalty, and an allowance.
    fn create(&self) -> u64 {
        self.contract.create_goal(
            &self.owner,
            &10_000,
            &(START + 10 * WEEK),
            &WEEK,
            &1_000,
            &WithdrawalRule::Penalty(PENALTY_BPS),
            &self.integrator,
            &INTEGRATOR_FEE_BPS,
            &self.allowance(),
        )
    }

    /// The owner with `count` open goals and funds; returns their ids.
    fn with_goals(&self, count: u32) -> std::vec::Vec<u64> {
        self.asset.mint(&self.owner, &1_000_000);
        (0..count).map(|_| self.create()).collect()
    }
}

#[test]
fn create_goal_with_an_allowance_for_an_owner_with_19_goals() {
    let s = setup();
    s.with_goals(MAX_OPEN_GOALS - 1);
    s.create();
    check("target-savings", "create_goal", &measured!(s.env));
}

#[test]
fn deposit_into_one_of_20_goals() {
    let s = setup();
    let ids = s.with_goals(MAX_OPEN_GOALS);
    s.contract.deposit(&s.owner, &ids[19], &500);
    check("target-savings", "deposit", &measured!(s.env));
}

#[test]
fn collect_after_missed_periods() {
    let s = setup();
    let ids = s.with_goals(MAX_OPEN_GOALS);
    // Period 3: periods 1 and 2 were missed, so a Missed event is emitted too.
    s.env
        .ledger()
        .with_mut(|li| li.timestamp = START + 3 * WEEK + 60);
    s.contract.collect(&ids[19]);
    check("target-savings", "collect", &measured!(s.env));
}

#[test]
fn withdraw_with_a_penalty_and_both_fees() {
    let s = setup();
    let ids = s.with_goals(MAX_OPEN_GOALS);
    s.contract.deposit(&s.owner, &ids[0], &5_000);
    // Early, so the penalty applies; the first of 20 goals, so the owner's
    // whole goal list is rewritten.
    let w = s.contract.withdraw(&s.owner, &ids[0]);
    assert!(w.penalty > 0 && w.loktin_fee > 0 && w.integrator_fee > 0);
    check("target-savings", "withdraw", &measured!(s.env));
}

#[test]
fn claim_fees() {
    let s = setup();
    let ids = s.with_goals(1);
    s.contract.deposit(&s.owner, &ids[0], &5_000);
    s.contract.withdraw(&s.owner, &ids[0]);
    assert!(s.contract.claim_fees(&s.integrator) > 0);
    check("target-savings", "claim_fees", &measured!(s.env));
}

#[test]
fn user_goals_with_20_open_goals() {
    let s = setup();
    s.with_goals(MAX_OPEN_GOALS);
    assert_eq!(s.contract.user_goals(&s.owner).len(), MAX_OPEN_GOALS);
    check("target-savings", "user_goals", &measured!(s.env));
}

#[test]
fn goal() {
    let s = setup();
    let ids = s.with_goals(1);
    s.contract.goal(&ids[0]);
    check("target-savings", "goal", &measured!(s.env));
}

#[test]
fn fee_admin_writes() {
    let s = setup();
    s.contract.set_loktin_fee(&50, &s.fee_admin);
    check("target-savings", "set_loktin_fee", &measured!(s.env));
    s.contract
        .set_fee_recipient(&Address::generate(&s.env), &s.fee_admin);
    check("target-savings", "set_fee_recipient", &measured!(s.env));
}

#[test]
fn pause_and_unpause() {
    let s = setup();
    s.contract.pause(&s.pauser);
    check("target-savings", "pause", &measured!(s.env));
    s.contract.unpause(&s.pauser);
    check("target-savings", "unpause", &measured!(s.env));
}

#[test]
fn upgrade() {
    let s = setup();
    let hash = s.env.deployer().upload_contract_wasm(WASM);
    s.contract.upgrade(&hash, &s.upgrader);
    check("target-savings", "upgrade", &measured!(s.env));
}

#[test]
fn access_control_writes() {
    let s = setup();
    let account = Address::generate(&s.env);
    let pauser = symbol_short!("pauser");
    s.contract.grant_role(&account, &pauser, &s.admin);
    check("target-savings", "grant_role", &measured!(s.env));
    s.contract.revoke_role(&account, &pauser, &s.admin);
    check("target-savings", "revoke_role", &measured!(s.env));
    s.contract.renounce_role(&pauser, &s.pauser);
    check("target-savings", "renounce_role", &measured!(s.env));
    s.contract
        .set_role_admin(&pauser, &symbol_short!("upgrader"));
    check("target-savings", "set_role_admin", &measured!(s.env));
    let new_admin = Address::generate(&s.env);
    s.contract
        .transfer_admin_role(&new_admin, &(s.env.ledger().sequence() + 1_000));
    check("target-savings", "transfer_admin_role", &measured!(s.env));
    s.contract.accept_admin_transfer();
    check("target-savings", "accept_admin_transfer", &measured!(s.env));
    s.contract.renounce_admin();
    check("target-savings", "renounce_admin", &measured!(s.env));
}
