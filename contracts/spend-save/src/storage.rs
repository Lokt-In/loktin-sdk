//! Stored types and storage access (S1, S2, S3, S9).

use loktin_common::ttl;
use soroban_sdk::{contracttype, Address, Env, Vec};

use crate::error::Error;

/// Schema version recorded in instance storage.
// Stays 1: an upgrade never changes it (docs/decisions/0002-accrued-fees.md).
pub const SCHEMA_VERSION: u32 = 1;

/// Most enrolments one user may hold (S9).
pub const MAX_ENROLLMENTS: u32 = 5;

/// Lowest skim percentage, 1% (P12).
pub const MIN_PERCENT_BPS: u32 = 100;

/// Highest skim percentage, 50% (P12).
pub const MAX_PERCENT_BPS: u32 = 5_000;

/// Instance configuration.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    /// The one token this instance holds (C8).
    pub token: Address,
    /// Receives the Loktin fee.
    pub fee_recipient: Address,
    /// Loktin fee rate copied into each new enrolment (R3).
    pub loktin_fee_bps: u32,
    /// The Target Savings contract skims may go to, if any (P15).
    pub target_savings: Option<Address>,
    /// Yield source slot, always `None` in this version (C7).
    pub yield_source: Option<Address>,
}

/// How a skim is worked out from a spend (P12). At least one part is set.
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SkimSettings {
    /// A percentage of the spend, in basis points, 100 to 5,000.
    pub percent_bps: Option<u32>,
    /// Round the spend up to a multiple of this unit, above zero.
    pub round_up_unit: Option<i128>,
}

/// Where skims go (P15).
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Destination {
    /// The user's Spend & Save balance.
    Balance,
    /// One of the user's open Target Savings goals.
    Goal(u64),
}

/// A change of withdrawal day waiting for its month (P16).
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DayChange {
    /// No change is waiting.
    None,
    /// The new withdrawal day, and the month index from which it applies.
    Pending(u32, u32),
}

/// A user's enrolment with one integrator.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Enrollment {
    pub user: Address,
    pub integrator: Address,
    pub integrator_fee_bps: u32,
    pub loktin_fee_bps: u32,
    pub skim: SkimSettings,
    pub monthly_cap: Option<i128>,
    pub destination: Destination,
    pub withdrawal_day: u32,
    /// A new withdrawal day and the month it takes effect from.
    pub pending_day: DayChange,
    /// The Spend & Save balance.
    pub principal: i128,
    pub shares: i128,
    /// The month `saved_this_month` belongs to.
    pub month_index: u32,
    pub saved_this_month: i128,
    pub total_spent: i128,
    pub total_saved: i128,
}

/// An enrolment as stored, versioned so an upgrade can read every earlier
/// form (S3).
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EnrollmentRecord {
    V1(Enrollment),
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataKey {
    /// Instance: [`Config`].
    Config,
    /// Persistent: one [`EnrollmentRecord`] per user and integrator.
    Enrollment(Address, Address),
    /// Persistent: the integrators a user is enrolled with.
    UserEnrollments(Address),
    /// Persistent: the fees accrued to one recipient and not yet claimed
    /// (W63). Never temporary, so an untouched entry is archived, not lost.
    AccruedFees(Address),
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

pub fn has_enrollment(e: &Env, user: &Address, integrator: &Address) -> bool {
    e.storage()
        .persistent()
        .has(&DataKey::Enrollment(user.clone(), integrator.clone()))
}

pub fn enrollment(e: &Env, user: &Address, integrator: &Address) -> Result<Enrollment, Error> {
    match e
        .storage()
        .persistent()
        .get(&DataKey::Enrollment(user.clone(), integrator.clone()))
    {
        Some(EnrollmentRecord::V1(enrollment)) => Ok(enrollment),
        None => Err(Error::EnrollmentNotFound),
    }
}

/// Saves an enrolment and extends its TTL.
pub fn save_enrollment(e: &Env, enrollment: &Enrollment) {
    let key = DataKey::Enrollment(enrollment.user.clone(), enrollment.integrator.clone());
    e.storage()
        .persistent()
        .set(&key, &EnrollmentRecord::V1(enrollment.clone()));
    ttl::extend_persistent(e, &key);
}

pub fn remove_enrollment(e: &Env, user: &Address, integrator: &Address) {
    e.storage()
        .persistent()
        .remove(&DataKey::Enrollment(user.clone(), integrator.clone()));
}

pub fn user_integrators(e: &Env, user: &Address) -> Vec<Address> {
    e.storage()
        .persistent()
        .get(&DataKey::UserEnrollments(user.clone()))
        .unwrap_or_else(|| Vec::new(e))
}

/// Saves a user's integrators and extends the entry's TTL, or removes the
/// entry once the list is empty.
pub fn set_user_integrators(e: &Env, user: &Address, integrators: &Vec<Address>) {
    let key = DataKey::UserEnrollments(user.clone());
    if integrators.is_empty() {
        e.storage().persistent().remove(&key);
    } else {
        e.storage().persistent().set(&key, integrators);
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
