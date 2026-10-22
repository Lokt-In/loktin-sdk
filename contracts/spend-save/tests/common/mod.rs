//! Shared test setup: a real Stellar asset contract as the token, a real
//! Target Savings contract, and a Spend & Save instance with every role held
//! by its own address.

#![allow(dead_code)]

use loktin_spend_save::{Destination, SkimSettings, SpendSave, SpendSaveClient};
use loktin_target_savings::{TargetSavings, TargetSavingsClient, WithdrawalRule};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{Address, Env};

/// 2026-10-22 00:00:00 UTC, a Thursday. Day 22 of month index 2026 * 12 + 9.
pub const START: u64 = 1_792_627_200;
pub const DAY: u64 = 86_400;
pub const WEEK: u64 = 7 * DAY;
pub const TODAY: u32 = 22;
/// 2026-11-01 00:00:00 UTC.
pub const NOVEMBER: u64 = START + 10 * DAY;
/// 2026-12-01 00:00:00 UTC.
pub const DECEMBER: u64 = NOVEMBER + 30 * DAY;
pub const MAX_ENTRY_TTL: u32 = 3_110_400;

pub struct Setup<'a> {
    pub env: Env,
    pub contract: SpendSaveClient<'a>,
    pub savings: TargetSavingsClient<'a>,
    pub token: TokenClient<'a>,
    pub asset: StellarAssetClient<'a>,
    pub issuer: Address,
    pub admin: Address,
    pub fee_admin: Address,
    pub pauser: Address,
    pub upgrader: Address,
    pub fee_recipient: Address,
    pub user: Address,
    pub integrator: Address,
    pub payee: Address,
}

pub fn env() -> Env {
    with_ledger(Env::default())
}

/// Sets the ledger used by every test: time [`START`], sequence 1,000 and
/// testnet's maximum entry TTL.
pub fn with_ledger(env: Env) -> Env {
    env.ledger().with_mut(|li| {
        li.timestamp = START;
        li.sequence_number = 1_000;
        li.min_persistent_entry_ttl = 4_096;
        li.min_temp_entry_ttl = 16;
        li.max_entry_ttl = MAX_ENTRY_TTL;
    });
    env
}

/// A Spend & Save instance with the given Loktin fee rate, linked to a
/// Target Savings instance on the same token. Auths are not mocked.
pub fn setup_with_fee<'a>(loktin_fee_bps: u32) -> Setup<'a> {
    setup_in(env(), loktin_fee_bps, true)
}

/// [`setup_with_fee`] in a given environment, with or without the link to
/// Target Savings.
pub fn setup_in<'a>(env: Env, loktin_fee_bps: u32, with_savings: bool) -> Setup<'a> {
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer.clone());
    let admin = Address::generate(&env);
    let fee_admin = Address::generate(&env);
    let pauser = Address::generate(&env);
    let upgrader = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let savings = env.register(
        TargetSavings,
        (
            admin.clone(),
            fee_admin.clone(),
            pauser.clone(),
            upgrader.clone(),
            sac.address(),
            fee_recipient.clone(),
            0_u32,
            DAY,
            None::<Address>,
        ),
    );
    let id = env.register(
        SpendSave,
        (
            admin.clone(),
            fee_admin.clone(),
            pauser.clone(),
            upgrader.clone(),
            sac.address(),
            fee_recipient.clone(),
            loktin_fee_bps,
            with_savings.then(|| savings.clone()),
            None::<Address>,
        ),
    );
    Setup {
        contract: SpendSaveClient::new(&env, &id),
        savings: TargetSavingsClient::new(&env, &savings),
        token: TokenClient::new(&env, &sac.address()),
        asset: StellarAssetClient::new(&env, &sac.address()),
        user: Address::generate(&env),
        integrator: Address::generate(&env),
        payee: Address::generate(&env),
        issuer,
        admin,
        fee_admin,
        pauser,
        upgrader,
        fee_recipient,
        env,
    }
}

/// [`setup_with_fee`] with a 0% Loktin fee and every auth mocked.
pub fn setup<'a>() -> Setup<'a> {
    let s = setup_with_fee(0);
    s.env.mock_all_auths();
    s
}

pub fn percent(bps: u32) -> SkimSettings {
    SkimSettings {
        percent_bps: Some(bps),
        round_up_unit: None,
    }
}

pub fn round_up(unit: i128) -> SkimSettings {
    SkimSettings {
        percent_bps: None,
        round_up_unit: Some(unit),
    }
}

impl Setup<'_> {
    pub fn set_time(&self, timestamp: u64) {
        self.env.ledger().with_mut(|li| li.timestamp = timestamp);
    }

    pub fn advance_ledgers(&self, ledgers: u32) {
        self.env
            .ledger()
            .with_mut(|li| li.sequence_number += ledgers);
    }

    pub fn mint(&self, to: &Address, amount: i128) {
        self.asset.mint(to, &amount);
    }

    pub fn enroll(
        &self,
        skim: SkimSettings,
        monthly_cap: Option<i128>,
        destination: Destination,
        withdrawal_day: u32,
    ) {
        self.contract.enroll(
            &self.user,
            &self.integrator,
            &0,
            &skim,
            &monthly_cap,
            &destination,
            &withdrawal_day,
        );
    }

    /// Enrols the user with a 10% skim into the balance, no cap, withdrawing
    /// on the 22nd.
    pub fn enroll_default(&self) {
        self.enroll(percent(1_000), None, Destination::Balance, TODAY);
    }

    pub fn principal(&self) -> i128 {
        self.contract
            .enrollment(&self.user, &self.integrator)
            .principal
    }

    /// A Target Savings goal for the user: target `target`, due in 10 weeks.
    pub fn create_goal(&self, target: i128) -> u64 {
        self.savings.create_goal(
            &self.user,
            &target,
            &(START + 10 * WEEK),
            &WEEK,
            &1,
            &WithdrawalRule::Lock,
            &self.integrator,
            &0,
            &None,
        )
    }
}
