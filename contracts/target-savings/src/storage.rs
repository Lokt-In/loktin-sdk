//! Stored types and storage access (S1, S2, S3).

use loktin_common::ttl;
use soroban_sdk::{contracttype, Address, Env, Vec};

use crate::error::Error;

/// Schema version recorded in instance storage.
pub const SCHEMA_VERSION: u32 = 1;

/// Most open goals one owner may hold (P10).
pub const MAX_OPEN_GOALS: u32 = 20;

/// Largest page `open_goals` returns (S5).
pub const MAX_PAGE: u32 = 50;

/// Instance configuration.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    /// The one token this instance holds (C8).
    pub token: Address,
    /// Receives the Loktin fee.
    pub fee_recipient: Address,
    /// Loktin fee rate copied into each new goal (R3).
    pub loktin_fee_bps: u32,
    /// Shortest cadence a goal may use, in seconds (C11).
    pub min_cadence: u64,
    /// Yield source slot, always `None` in this version (C7).
    pub yield_source: Option<Address>,
}

pub use loktin_common::target_savings::{Goal, WithdrawalRule};

/// A goal as stored, versioned so an upgrade can read every earlier form (S3).
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GoalRecord {
    V1(Goal),
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataKey {
    /// Instance: [`Config`].
    Config,
    /// Instance: the id the next goal receives.
    NextId,
    /// Persistent: one [`GoalRecord`] per open goal.
    Goal(u64),
    /// Persistent: the ids of an owner's open goals.
    UserGoals(Address),
}

pub fn config(e: &Env) -> Result<Config, Error> {
    e.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(Error::ConfigMissing)
}

pub fn set_config(e: &Env, config: &Config) {
    e.storage().instance().set(&DataKey::Config, config);
}

pub fn next_id(e: &Env) -> Result<u64, Error> {
    e.storage()
        .instance()
        .get(&DataKey::NextId)
        .ok_or(Error::ConfigMissing)
}

pub fn set_next_id(e: &Env, id: u64) {
    e.storage().instance().set(&DataKey::NextId, &id);
}

pub fn goal(e: &Env, id: u64) -> Result<Goal, Error> {
    match e.storage().persistent().get(&DataKey::Goal(id)) {
        Some(GoalRecord::V1(goal)) => Ok(goal),
        None => Err(Error::GoalNotFound),
    }
}

/// Saves a goal and extends its TTL.
pub fn save_goal(e: &Env, goal: &Goal) {
    let key = DataKey::Goal(goal.id);
    e.storage()
        .persistent()
        .set(&key, &GoalRecord::V1(goal.clone()));
    ttl::extend_persistent(e, &key);
}

pub fn remove_goal(e: &Env, id: u64) {
    e.storage().persistent().remove(&DataKey::Goal(id));
}

pub fn user_goal_ids(e: &Env, owner: &Address) -> Vec<u64> {
    e.storage()
        .persistent()
        .get(&DataKey::UserGoals(owner.clone()))
        .unwrap_or_else(|| Vec::new(e))
}

/// Saves an owner's goal ids and extends the entry's TTL, or removes the
/// entry once the list is empty.
pub fn set_user_goal_ids(e: &Env, owner: &Address, ids: &Vec<u64>) {
    let key = DataKey::UserGoals(owner.clone());
    if ids.is_empty() {
        e.storage().persistent().remove(&key);
    } else {
        e.storage().persistent().set(&key, ids);
        ttl::extend_persistent(e, &key);
    }
}
