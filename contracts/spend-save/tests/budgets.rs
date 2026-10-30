//! T10: the resources of every public function that writes, each in its
//! worst realistic state, stay under a quarter of testnet's per-transaction
//! limits. Runs the release Wasm of both contracts built by
//! `stellar contract build`, so VM instantiation, execution and Wasm reads
//! are counted. Auths are mocked, so signature checks are not, and the
//! transaction's own size is not modelled.
//!
//! `cargo test -p loktin-spend-save --test budgets -- --nocapture` prints
//! one line per function.

mod common;

use common::{with_ledger, START, TODAY, WEEK};
use loktin_common::budgets::check;
use loktin_common::measured;
use loktin_spend_save::{Destination, SkimSettings, SpendSaveClient, MAX_ENROLLMENTS};
use loktin_target_savings::{TargetSavingsClient, WithdrawalRule};
use soroban_sdk::testutils::{Address as _, EnvTestConfig};
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{symbol_short, Address, Env, MuxedAddress};

const WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/wasm32v1-none/release/loktin_spend_save.wasm"
));
const TARGET_SAVINGS_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/wasm32v1-none/release/loktin_target_savings.wasm"
));

/// The highest Loktin and integrator fees.
const LOKTIN_FEE_BPS: u32 = 100;
const INTEGRATOR_FEE_BPS: u32 = 100;

struct Wasm<'a> {
    env: Env,
    contract: SpendSaveClient<'a>,
    savings: TargetSavingsClient<'a>,
    asset: StellarAssetClient<'a>,
    admin: Address,
    fee_admin: Address,
    pauser: Address,
    upgrader: Address,
    user: Address,
    integrator: Address,
    payee: Address,
}

/// The release Wasm of both contracts, with every role held by its own
/// address, the highest Loktin fee, and every auth mocked. The user holds
/// funds. No test snapshot is written.
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
    let fee_recipient = Address::generate(&env);
    let savings = env.register(
        TARGET_SAVINGS_WASM,
        (
            admin.clone(),
            fee_admin.clone(),
            pauser.clone(),
            upgrader.clone(),
            sac.address(),
            fee_recipient.clone(),
            LOKTIN_FEE_BPS,
            common::DAY,
            None::<Address>,
        ),
    );
    let id = env.register(
        WASM,
        (
            admin.clone(),
            fee_admin.clone(),
            pauser.clone(),
            upgrader.clone(),
            sac.address(),
            fee_recipient,
            LOKTIN_FEE_BPS,
            Some(savings.clone()),
            None::<Address>,
        ),
    );
    let s = Wasm {
        contract: SpendSaveClient::new(&env, &id),
        savings: TargetSavingsClient::new(&env, &savings),
        asset: StellarAssetClient::new(&env, &sac.address()),
        user: Address::generate(&env),
        integrator: Address::generate(&env),
        payee: Address::generate(&env),
        admin,
        fee_admin,
        pauser,
        upgrader,
        env,
    };
    s.asset.mint(&s.user, &1_000_000_000);
    s
}

/// A 10% skim and a round-up to 100, the most work per spend.
fn both() -> SkimSettings {
    SkimSettings {
        percent_bps: Some(1_000),
        round_up_unit: Some(100),
    }
}

impl Wasm<'_> {
    /// Enrols the user with `integrator`.
    fn enroll_with(&self, integrator: &Address, destination: Destination) {
        self.contract.enroll(
            &self.user,
            integrator,
            &INTEGRATOR_FEE_BPS,
            &both(),
            &Some(1_000_000),
            &destination,
            &TODAY,
        );
    }

    /// The user enrolled with `others` other integrators first.
    fn with_others(&self, others: u32) {
        for _ in 0..others {
            self.enroll_with(&Address::generate(&self.env), Destination::Balance);
        }
    }

    /// A Target Savings goal of the user that a skim can go into.
    fn goal(&self) -> u64 {
        self.savings.create_goal(
            &self.user,
            &1_000_000,
            &(START + 10 * WEEK),
            &WEEK,
            &1_000,
            &WithdrawalRule::Lock,
            &self.integrator,
            &0,
            &None,
        )
    }
}

#[test]
fn enroll_with_the_last_free_enrolment() {
    let s = setup();
    s.with_others(MAX_ENROLLMENTS - 1);
    let goal = s.goal();
    s.enroll_with(&s.integrator, Destination::Goal(goal));
    check("spend-save", "enroll", &measured!(s.env));
}

#[test]
fn update_settings() {
    let s = setup();
    s.with_others(MAX_ENROLLMENTS - 1);
    s.enroll_with(&s.integrator, Destination::Balance);
    let goal = s.goal();
    s.contract.update_settings(
        &s.user,
        &s.integrator,
        &both(),
        &Some(2_000_000),
        &Destination::Goal(goal),
        &(TODAY + 1),
    );
    check("spend-save", "update_settings", &measured!(s.env));
}

#[test]
fn pay_and_save_into_a_goal() {
    let s = setup();
    let goal = s.goal();
    s.enroll_with(&s.integrator, Destination::Goal(goal));
    let to = MuxedAddress::from(&s.payee);
    let saving = s.contract.pay_and_save(&s.user, &s.integrator, &to, &1_234);
    assert!(saving.to_goal > 0);
    check("spend-save", "pay_and_save", &measured!(s.env));
}

#[test]
fn save_for_spend_into_a_goal() {
    let s = setup();
    let goal = s.goal();
    s.enroll_with(&s.integrator, Destination::Goal(goal));
    let saving = s.contract.save_for_spend(&s.user, &s.integrator, &1_234);
    assert!(saving.to_goal > 0);
    check("spend-save", "save_for_spend", &measured!(s.env));
}

#[test]
fn withdraw_with_both_fees() {
    let s = setup();
    s.enroll_with(&s.integrator, Destination::Balance);
    s.contract.save_for_spend(&s.user, &s.integrator, &100_000);
    // The 22nd is the withdrawal day, so the window is open now.
    let w = s.contract.withdraw(&s.user, &s.integrator, &5_000);
    assert!(w.loktin_fee > 0 && w.integrator_fee > 0);
    check("spend-save", "withdraw", &measured!(s.env));
}

#[test]
fn close_with_five_enrolments() {
    let s = setup();
    s.enroll_with(&s.integrator, Destination::Balance);
    s.with_others(MAX_ENROLLMENTS - 1);
    // The first of five, so the user's whole integrator list is rewritten.
    s.contract.close(&s.user, &s.integrator);
    check("spend-save", "close", &measured!(s.env));
}

#[test]
fn claim_fees() {
    let s = setup();
    s.enroll_with(&s.integrator, Destination::Balance);
    s.contract.save_for_spend(&s.user, &s.integrator, &100_000);
    s.contract.withdraw(&s.user, &s.integrator, &5_000);
    assert!(s.contract.claim_fees(&s.integrator) > 0);
    check("spend-save", "claim_fees", &measured!(s.env));
}

#[test]
fn fee_admin_writes() {
    let s = setup();
    s.contract.set_loktin_fee(&50, &s.fee_admin);
    check("spend-save", "set_loktin_fee", &measured!(s.env));
    s.contract
        .set_fee_recipient(&Address::generate(&s.env), &s.fee_admin);
    check("spend-save", "set_fee_recipient", &measured!(s.env));
}

#[test]
fn pause_and_unpause() {
    let s = setup();
    s.contract.pause(&s.pauser);
    check("spend-save", "pause", &measured!(s.env));
    s.contract.unpause(&s.pauser);
    check("spend-save", "unpause", &measured!(s.env));
}

#[test]
fn upgrade() {
    let s = setup();
    let hash = s.env.deployer().upload_contract_wasm(WASM);
    s.contract.upgrade(&hash, &s.upgrader);
    check("spend-save", "upgrade", &measured!(s.env));
}

#[test]
fn access_control_writes() {
    let s = setup();
    let account = Address::generate(&s.env);
    let pauser = symbol_short!("pauser");
    s.contract.grant_role(&account, &pauser, &s.admin);
    check("spend-save", "grant_role", &measured!(s.env));
    s.contract.revoke_role(&account, &pauser, &s.admin);
    check("spend-save", "revoke_role", &measured!(s.env));
    s.contract.renounce_role(&pauser, &s.pauser);
    check("spend-save", "renounce_role", &measured!(s.env));
    s.contract
        .set_role_admin(&pauser, &symbol_short!("upgrader"));
    check("spend-save", "set_role_admin", &measured!(s.env));
    let new_admin = Address::generate(&s.env);
    s.contract
        .transfer_admin_role(&new_admin, &(s.env.ledger().sequence() + 1_000));
    check("spend-save", "transfer_admin_role", &measured!(s.env));
    s.contract.accept_admin_transfer();
    check("spend-save", "accept_admin_transfer", &measured!(s.env));
    s.contract.renounce_admin();
    check("spend-save", "renounce_admin", &measured!(s.env));
}
