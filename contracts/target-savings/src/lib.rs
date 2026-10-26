//! Target Savings: saving toward a goal with scheduled or manual deposits.
//!
//! Implements sections 4.3, 5, 6.1 and 6.2 of `docs/architecture.md`.

#![no_std]

mod error;
mod events;
mod storage;

use loktin_common::{fees, roles, schedule, ttl};
use soroban_sdk::{
    contract, contractimpl, contractmeta, contracttype, token, Address, BytesN, Env, Symbol, Vec,
};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_contract_utils::pausable::{self as pausable, Pausable};
use stellar_contract_utils::upgradeable::{self as upgradeable, Upgradeable};

pub use crate::error::Error;
pub use crate::events::{
    DepositKind, Deposited, FeeRecipientSet, FeesClaimed, GoalClosed, GoalCreated, LoktinFeeSet,
    Missed, Upgraded, Withdrawn,
};
pub use crate::storage::{DataKey, Goal, GoalRecord, WithdrawalRule, MAX_OPEN_GOALS, MAX_PAGE};

contractmeta!(key = "binver", val = "0.2.0");

/// How a withdrawal splits between its recipients.
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Withdrawal {
    /// The whole principal withdrawn.
    pub amount: i128,
    /// Early-withdrawal penalty, paid to the integrator.
    pub penalty: i128,
    /// Loktin fee, paid to the fee recipient.
    pub loktin_fee: i128,
    /// Integrator fee, paid to the integrator.
    pub integrator_fee: i128,
    /// What the owner receives.
    pub to_user: i128,
}

#[contract]
pub struct TargetSavings;

#[contractimpl]
impl TargetSavings {
    /// Sets up the instance. The token, minimum cadence and yield source are
    /// fixed from here on (C7, C8, C11).
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        e: &Env,
        admin: Address,
        fee_admin: Address,
        pauser: Address,
        upgrader: Address,
        token: Address,
        fee_recipient: Address,
        loktin_fee_bps: u32,
        min_cadence: u64,
        yield_source: Option<Address>,
    ) -> Result<(), Error> {
        if loktin_fee_bps > fees::MAX_LOKTIN_FEE_BPS {
            return Err(Error::RateAboveCap);
        }
        if min_cadence == 0 {
            return Err(Error::InvalidCadence);
        }
        if yield_source.is_some() {
            return Err(Error::YieldSourceNotSupported);
        }
        if fee_recipient == e.current_contract_address() {
            return Err(Error::InvalidFeeRecipient);
        }

        access_control::set_admin(e, &admin);
        access_control::grant_role_no_auth(e, &fee_admin, &roles::FEE_ADMIN, &admin);
        access_control::grant_role_no_auth(e, &pauser, &roles::PAUSER, &admin);
        access_control::grant_role_no_auth(e, &upgrader, &roles::UPGRADER, &admin);

        storage::set_config(
            e,
            &storage::Config {
                token,
                fee_recipient,
                loktin_fee_bps,
                min_cadence,
                yield_source: None,
            },
        );
        storage::set_next_id(e, 1);
        upgradeable::set_schema_version(e, storage::SCHEMA_VERSION);
        ttl::extend_instance(e);
        Ok(())
    }

    /// Creates a goal for `owner` and returns its id. If `allowance` is
    /// `Some((amount, live_until_ledger))`, the owner also approves this
    /// contract to collect scheduled deposits, in the same call (S4).
    #[allow(clippy::too_many_arguments)]
    pub fn create_goal(
        e: &Env,
        owner: Address,
        target: i128,
        deadline: u64,
        cadence: u64,
        deposit_size: i128,
        rule: WithdrawalRule,
        integrator: Address,
        integrator_fee_bps: u32,
        allowance: Option<(i128, u32)>,
    ) -> Result<u64, Error> {
        owner.require_auth();
        pausable::when_not_paused(e);
        let config = storage::config(e)?;
        let now = e.ledger().timestamp();

        if target <= 0 {
            return Err(Error::InvalidTarget);
        }
        if deposit_size <= 0 {
            return Err(Error::InvalidDeposit);
        }
        if deadline <= now {
            return Err(Error::InvalidDeadline);
        }
        if cadence < config.min_cadence {
            return Err(Error::CadenceTooShort);
        }
        let first_due = now.checked_add(cadence).ok_or(Error::Overflow)?;
        if first_due > deadline {
            return Err(Error::NoPeriodBeforeDeadline);
        }
        if let WithdrawalRule::Penalty(bps) = rule {
            if bps > fees::MAX_PENALTY_BPS {
                return Err(Error::RateAboveCap);
            }
        }
        if integrator_fee_bps > fees::MAX_INTEGRATOR_FEE_BPS {
            return Err(Error::RateAboveCap);
        }
        // Fees and penalties paid to this contract would be held with no
        // principal recording them.
        if integrator == e.current_contract_address() {
            return Err(Error::InvalidIntegrator);
        }
        let mut ids = storage::user_goal_ids(e, &owner);
        if ids.len() >= MAX_OPEN_GOALS {
            return Err(Error::TooManyGoals);
        }

        let id = storage::next_id(e)?;
        storage::set_next_id(e, id.checked_add(1).ok_or(Error::Overflow)?);
        let goal = Goal {
            id,
            owner: owner.clone(),
            integrator: integrator.clone(),
            integrator_fee_bps,
            loktin_fee_bps: config.loktin_fee_bps,
            target,
            deadline,
            cadence,
            deposit_size,
            rule,
            start: now,
            principal: 0,
            shares: 0,
            last_collected_period: 0,
            missed_count: 0,
        };
        storage::save_goal(e, &goal);
        ids.push_back(id);
        storage::set_user_goal_ids(e, &owner, &ids);
        ttl::extend_instance(e);

        if let Some((amount, live_until_ledger)) = allowance {
            token::TokenClient::new(e, &config.token).approve(
                &owner,
                &e.current_contract_address(),
                &amount,
                &live_until_ledger,
            );
        }

        GoalCreated {
            goal_id: id,
            owner,
            integrator,
            target,
            deadline,
            cadence,
            deposit_size,
            rule,
            start: now,
            loktin_fee_bps: config.loktin_fee_bps,
            integrator_fee_bps,
        }
        .publish(e);
        Ok(id)
    }

    /// Deposits `amount` from the owner into their goal (P7).
    pub fn deposit(e: &Env, owner: Address, goal_id: u64, amount: i128) -> Result<(), Error> {
        owner.require_auth();
        pausable::when_not_paused(e);
        let config = storage::config(e)?;
        let mut goal = storage::goal(e, goal_id)?;
        if goal.owner != owner {
            return Err(Error::NotOwner);
        }
        if amount <= 0 {
            return Err(Error::InvalidDeposit);
        }
        if e.ledger().timestamp() > goal.deadline {
            return Err(Error::DeadlinePassed);
        }
        let needed = goal
            .target
            .checked_sub(goal.principal)
            .ok_or(Error::Overflow)?;
        if amount > needed {
            return Err(Error::ExceedsTarget);
        }

        add_principal(&mut goal, amount)?;
        storage::save_goal(e, &goal);
        ttl::extend_instance(e);

        let contract = e.current_contract_address();
        token::TokenClient::new(e, &config.token).transfer(&owner, &contract, &amount);

        Deposited {
            goal_id,
            owner,
            kind: DepositKind::Manual,
            amount,
            principal: goal.principal,
        }
        .publish(e);
        Ok(())
    }

    /// Collects the deposit for the current period. Anyone may call it (C3).
    pub fn collect(e: &Env, goal_id: u64) -> Result<(), Error> {
        pausable::when_not_paused(e);
        let config = storage::config(e)?;
        let mut goal = storage::goal(e, goal_id)?;

        let now = e.ledger().timestamp();
        let period =
            schedule::current_period(goal.start, goal.cadence, now)?.ok_or(Error::NotDue)?;
        // Scheduled deposits stop once the deadline has passed (P2). The
        // deadline second itself is still inside the goal.
        if now > goal.deadline {
            return Err(Error::DeadlinePassed);
        }
        if goal.principal >= goal.target {
            return Err(Error::TargetReached);
        }
        if period == goal.last_collected_period {
            return Err(Error::AlreadyCollected);
        }

        let needed = goal
            .target
            .checked_sub(goal.principal)
            .ok_or(Error::Overflow)?;
        let amount = goal.deposit_size.min(needed);
        let token = token::TokenClient::new(e, &config.token);
        let contract = e.current_contract_address();
        if token.balance(&goal.owner) < amount || token.allowance(&goal.owner, &contract) < amount {
            return Err(Error::Shortfall);
        }

        let missed = schedule::missed_between(goal.last_collected_period, period);
        goal.missed_count = goal
            .missed_count
            .checked_add(missed)
            .ok_or(Error::Overflow)?;
        goal.last_collected_period = period;
        add_principal(&mut goal, amount)?;
        storage::save_goal(e, &goal);
        ttl::extend_instance(e);

        token.transfer_from(&contract, &goal.owner, &contract, &amount);

        if missed > 0 {
            Missed {
                goal_id,
                periods: missed,
                missed_count: goal.missed_count,
            }
            .publish(e);
        }
        Deposited {
            goal_id,
            owner: goal.owner,
            kind: DepositKind::Scheduled,
            amount,
            principal: goal.principal,
        }
        .publish(e);
        Ok(())
    }

    /// Pays the owner's share of the whole goal and closes it (P5, P6, R2).
    /// The penalty and integrator fee accrue to the integrator, and the
    /// Loktin fee to the current fee recipient, for each to claim with
    /// `claim_fees` (W63). Never blocked by pause (C4).
    pub fn withdraw(e: &Env, owner: Address, goal_id: u64) -> Result<Withdrawal, Error> {
        owner.require_auth();
        let config = storage::config(e)?;
        let goal = storage::goal(e, goal_id)?;
        if goal.owner != owner {
            return Err(Error::NotOwner);
        }
        let withdrawal = breakdown(e, &goal)?;

        storage::remove_goal(e, goal_id);
        let mut ids = storage::user_goal_ids(e, &owner);
        if let Some(index) = ids.first_index_of(goal_id) {
            ids.remove(index);
        }
        storage::set_user_goal_ids(e, &owner, &ids);
        let to_integrator = withdrawal
            .penalty
            .checked_add(withdrawal.integrator_fee)
            .ok_or(Error::Overflow)?;
        storage::add_accrued_fees(e, &goal.integrator, to_integrator)?;
        storage::add_accrued_fees(e, &config.fee_recipient, withdrawal.loktin_fee)?;
        ttl::extend_instance(e);

        // The only transfer: no recipient of fees can block the owner (S8).
        if withdrawal.to_user > 0 {
            token::TokenClient::new(e, &config.token).transfer(
                &e.current_contract_address(),
                &owner,
                &withdrawal.to_user,
            );
        }

        Withdrawn {
            goal_id,
            owner: owner.clone(),
            amount: withdrawal.amount,
            penalty: withdrawal.penalty,
            loktin_fee: withdrawal.loktin_fee,
            integrator_fee: withdrawal.integrator_fee,
            to_user: withdrawal.to_user,
        }
        .publish(e);
        GoalClosed { goal_id, owner }.publish(e);
        Ok(withdrawal)
    }

    /// Pays out every fee accrued to `recipient` and returns the amount
    /// (W63). Signed by the recipient. Never blocked by pause (C4).
    pub fn claim_fees(e: &Env, recipient: Address) -> Result<i128, Error> {
        recipient.require_auth();
        let config = storage::config(e)?;
        let amount = storage::take_accrued_fees(e, &recipient);
        if amount == 0 {
            return Err(Error::NothingToClaim);
        }
        ttl::extend_instance(e);

        token::TokenClient::new(e, &config.token).transfer(
            &e.current_contract_address(),
            &recipient,
            &amount,
        );

        FeesClaimed { recipient, amount }.publish(e);
        Ok(amount)
    }

    /// Returns the fees accrued to `recipient` and not yet claimed (W63).
    pub fn accrued_fees(e: &Env, recipient: Address) -> i128 {
        storage::accrued_fees(e, &recipient)
    }

    /// Returns an open goal.
    pub fn goal(e: &Env, id: u64) -> Result<Goal, Error> {
        storage::goal(e, id)
    }

    /// Returns all of an owner's open goals, at most 20.
    pub fn user_goals(e: &Env, owner: Address) -> Result<Vec<Goal>, Error> {
        let mut goals = Vec::new(e);
        for id in storage::user_goal_ids(e, &owner) {
            goals.push_back(storage::goal(e, id)?);
        }
        Ok(goals)
    }

    /// Returns the open goals with ids from `from_id` up to, but not
    /// including, `from_id + limit`, skipping closed ones (S5).
    pub fn open_goals(e: &Env, from_id: u64, limit: u32) -> Result<Vec<Goal>, Error> {
        if limit == 0 || limit > MAX_PAGE {
            return Err(Error::InvalidLimit);
        }
        let end = from_id
            .saturating_add(u64::from(limit))
            .min(storage::next_id(e)?);
        let mut goals = Vec::new(e);
        for id in from_id..end {
            if let Ok(goal) = storage::goal(e, id) {
                goals.push_back(goal);
            }
        }
        Ok(goals)
    }

    /// Returns the id the next goal will receive.
    pub fn next_id(e: &Env) -> Result<u64, Error> {
        storage::next_id(e)
    }

    /// Returns how a withdrawal of the goal would split right now.
    pub fn preview_withdraw(e: &Env, goal_id: u64) -> Result<Withdrawal, Error> {
        breakdown(e, &storage::goal(e, goal_id)?)
    }

    /// Returns the token this instance holds.
    pub fn token(e: &Env) -> Result<Address, Error> {
        Ok(storage::config(e)?.token)
    }

    /// Returns the Loktin fee rate that new goals receive.
    pub fn loktin_fee_bps(e: &Env) -> Result<u32, Error> {
        Ok(storage::config(e)?.loktin_fee_bps)
    }

    /// Returns the address Loktin fees are paid to.
    pub fn fee_recipient(e: &Env) -> Result<Address, Error> {
        Ok(storage::config(e)?.fee_recipient)
    }

    /// Returns the shortest cadence a goal may use, in seconds.
    pub fn min_cadence(e: &Env) -> Result<u64, Error> {
        Ok(storage::config(e)?.min_cadence)
    }

    /// Sets the Loktin fee rate for goals created from now on (R3, R6).
    /// Fee-admin only.
    pub fn set_loktin_fee(e: &Env, loktin_fee_bps: u32, caller: Address) -> Result<(), Error> {
        access_control::ensure_role(e, &roles::FEE_ADMIN, &caller);
        caller.require_auth();
        if loktin_fee_bps > fees::MAX_LOKTIN_FEE_BPS {
            return Err(Error::RateAboveCap);
        }
        let mut config = storage::config(e)?;
        config.loktin_fee_bps = loktin_fee_bps;
        storage::set_config(e, &config);
        ttl::extend_instance(e);
        LoktinFeeSet { loktin_fee_bps }.publish(e);
        Ok(())
    }

    /// Sets the address Loktin fees are paid to (R6). Fee-admin only.
    pub fn set_fee_recipient(
        e: &Env,
        fee_recipient: Address,
        caller: Address,
    ) -> Result<(), Error> {
        access_control::ensure_role(e, &roles::FEE_ADMIN, &caller);
        caller.require_auth();
        if fee_recipient == e.current_contract_address() {
            return Err(Error::InvalidFeeRecipient);
        }
        let mut config = storage::config(e)?;
        config.fee_recipient = fee_recipient.clone();
        storage::set_config(e, &config);
        ttl::extend_instance(e);
        FeeRecipientSet { fee_recipient }.publish(e);
        Ok(())
    }
}

#[contractimpl(contracttrait)]
impl AccessControl for TargetSavings {}

#[contractimpl(contracttrait)]
impl Pausable for TargetSavings {
    /// Pauses the contract. Pauser only (C2, C4).
    fn pause(e: &Env, caller: Address) {
        access_control::ensure_role(e, &roles::PAUSER, &caller);
        caller.require_auth();
        pausable::pause(e);
        ttl::extend_instance(e);
    }

    /// Unpauses the contract. Pauser only (C2, C4).
    fn unpause(e: &Env, caller: Address) {
        access_control::ensure_role(e, &roles::PAUSER, &caller);
        caller.require_auth();
        pausable::unpause(e);
        ttl::extend_instance(e);
    }
}

#[contractimpl]
impl Upgradeable for TargetSavings {
    /// Replaces the contract code. Upgrader only (C2, C5).
    fn upgrade(e: &Env, new_wasm_hash: BytesN<32>, operator: Address) {
        access_control::ensure_role(e, &roles::UPGRADER, &operator);
        operator.require_auth();
        ttl::extend_instance(e);
        Upgraded {
            new_wasm_hash: new_wasm_hash.clone(),
            operator,
        }
        .publish(e);
        upgradeable::upgrade(e, &new_wasm_hash);
    }
}

fn add_principal(goal: &mut Goal, amount: i128) -> Result<(), Error> {
    goal.principal = goal.principal.checked_add(amount).ok_or(Error::Overflow)?;
    // One share per unit of principal while no yield source exists (C7).
    goal.shares = goal.principal;
    Ok(())
}

fn breakdown(e: &Env, goal: &Goal) -> Result<Withdrawal, Error> {
    let earned = goal.principal >= goal.target || e.ledger().timestamp() >= goal.deadline;
    let penalty_bps = if goal.principal == 0 || earned {
        0
    } else {
        match goal.rule {
            WithdrawalRule::Penalty(bps) => bps,
            WithdrawalRule::Lock => return Err(Error::Locked),
        }
    };
    let parts = fees::withdrawal_breakdown(
        goal.principal,
        penalty_bps,
        goal.loktin_fee_bps,
        goal.integrator_fee_bps,
    )?;
    Ok(Withdrawal {
        amount: goal.principal,
        penalty: parts.penalty,
        loktin_fee: parts.loktin_fee,
        integrator_fee: parts.integrator_fee,
        to_user: parts.to_user,
    })
}
