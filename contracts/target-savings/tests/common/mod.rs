//! Shared test setup: a real Stellar asset contract as the token and a
//! Target Savings instance with every role held by its own address.

#![allow(dead_code)]

use loktin_target_savings::{TargetSavings, TargetSavingsClient, WithdrawalRule};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{Address, Env};

/// 2026-10-22 00:00:00 UTC.
pub const START: u64 = 1_792_627_200;
pub const DAY: u64 = 86_400;
pub const WEEK: u64 = 7 * DAY;
pub const MIN_CADENCE: u64 = DAY;
pub const MAX_ENTRY_TTL: u32 = 3_110_400;

pub struct Setup<'a> {
    pub env: Env,
    pub contract: TargetSavingsClient<'a>,
    pub token: TokenClient<'a>,
    pub asset: StellarAssetClient<'a>,
    pub issuer: Address,
    pub admin: Address,
    pub fee_admin: Address,
    pub pauser: Address,
    pub upgrader: Address,
    pub fee_recipient: Address,
    pub owner: Address,
    pub integrator: Address,
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

/// A Target Savings instance with a 1-day minimum cadence and the given
/// Loktin fee rate. Auths are not mocked.
pub fn setup_with_fee<'a>(loktin_fee_bps: u32) -> Setup<'a> {
    setup_in(env(), loktin_fee_bps)
}

/// [`setup_with_fee`] in a given environment.
pub fn setup_in<'a>(env: Env, loktin_fee_bps: u32) -> Setup<'a> {
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer.clone());
    let admin = Address::generate(&env);
    let fee_admin = Address::generate(&env);
    let pauser = Address::generate(&env);
    let upgrader = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let id = env.register(
        TargetSavings,
        (
            admin.clone(),
            fee_admin.clone(),
            pauser.clone(),
            upgrader.clone(),
            sac.address(),
            fee_recipient.clone(),
            loktin_fee_bps,
            MIN_CADENCE,
            None::<Address>,
        ),
    );
    Setup {
        contract: TargetSavingsClient::new(&env, &id),
        token: TokenClient::new(&env, &sac.address()),
        asset: StellarAssetClient::new(&env, &sac.address()),
        owner: Address::generate(&env),
        integrator: Address::generate(&env),
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

    /// The allowance argument for `create_goal`: `amount`, live for the
    /// maximum entry TTL.
    pub fn allowance(&self, amount: i128) -> Option<(i128, u32)> {
        Some((amount, self.env.ledger().sequence() + MAX_ENTRY_TTL - 1))
    }

    /// A weekly goal of 1,000 toward a target of 10,000 due in 10 weeks,
    /// with no allowance.
    pub fn create_default(&self, rule: WithdrawalRule) -> u64 {
        self.contract.create_goal(
            &self.owner,
            &10_000,
            &(START + 10 * WEEK),
            &WEEK,
            &1_000,
            &rule,
            &self.integrator,
            &0,
            &None,
        )
    }
}
