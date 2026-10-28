//! Stored types and storage access (S1, S2, S3).

use loktin_common::ttl;
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{contracttype, Address, Env, Vec};

use crate::error::Error;

/// Schema version recorded in instance storage.
// Stays 1: an upgrade never changes it (docs/decisions/0002-accrued-fees.md).
pub const SCHEMA_VERSION: u32 = 1;

/// Most open goals one owner may hold (P10).
pub const MAX_OPEN_GOALS: u32 = 20;

/// Most ids `create_goal` tries for one goal before giving up (W75).
pub const MAX_ID_ATTEMPTS: u32 = 8;

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
    /// Instance: the id the next goal received, up to 0.2.0. No longer read
    /// or written; kept because instances deployed before 0.3.0 still hold
    /// the entry.
    NextId,
    /// Persistent: one [`GoalRecord`] per open goal.
    Goal(u64),
    /// Persistent: the ids of an owner's open goals.
    UserGoals(Address),
    /// Persistent: the fees accrued to one recipient and not yet claimed
    /// (W63). Never temporary, so an untouched entry is archived, not lost.
    AccruedFees(Address),
    /// Persistent: how many goal ids an owner has used (W75). It only ever
    /// grows, even when goals close, so an id is never reused.
    GoalsCreated(Address),
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

/// Returns how many goal ids `owner` has used, or 0.
pub fn goals_created(e: &Env, owner: &Address) -> u64 {
    e.storage()
        .persistent()
        .get(&DataKey::GoalsCreated(owner.clone()))
        .unwrap_or(0)
}

/// Saves how many goal ids `owner` has used and extends the entry's TTL.
pub fn set_goals_created(e: &Env, owner: &Address, count: u64) {
    let key = DataKey::GoalsCreated(owner.clone());
    e.storage().persistent().set(&key, &count);
    ttl::extend_persistent(e, &key);
}

/// The goal id for `owner` and its counter value (W75): the first 8 bytes,
/// big-endian, of `sha256(owner as XDR, then the counter as 8 big-endian
/// bytes)`. It depends only on the arguments, so simulation sees the same
/// key that execution writes.
pub fn goal_id_for(e: &Env, owner: &Address, counter: u64) -> u64 {
    let mut data = owner.clone().to_xdr(e);
    data.extend_from_array(&counter.to_be_bytes());
    let hash = e.crypto().sha256(&data).to_array();
    let mut first = [0_u8; 8];
    first.copy_from_slice(&hash[..8]);
    u64::from_be_bytes(first)
}

pub fn has_goal(e: &Env, id: u64) -> bool {
    e.storage().persistent().has(&DataKey::Goal(id))
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

/// Returns the fees accrued to `recipient` and not yet claimed, or 0.
pub fn accrued_fees(e: &Env, recipient: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&DataKey::AccruedFees(recipient.clone()))
        .unwrap_or(0)
}

/// Adds `amount` to the fees accrued to `recipient` and extends the entry's
/// TTL. Writes nothing for an amount of 0.
pub fn add_accrued_fees(e: &Env, recipient: &Address, amount: i128) -> Result<(), Error> {
    if amount == 0 {
        return Ok(());
    }
    let total = accrued_fees(e, recipient)
        .checked_add(amount)
        .ok_or(Error::Overflow)?;
    let key = DataKey::AccruedFees(recipient.clone());
    e.storage().persistent().set(&key, &total);
    ttl::extend_persistent(e, &key);
    Ok(())
}

/// Removes the fees accrued to `recipient` and returns them, or 0 when there
/// are none.
pub fn take_accrued_fees(e: &Env, recipient: &Address) -> i128 {
    let amount = accrued_fees(e, recipient);
    if amount != 0 {
        e.storage()
            .persistent()
            .remove(&DataKey::AccruedFees(recipient.clone()));
    }
    amount
}
