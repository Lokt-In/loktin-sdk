//! Spend & Save: skims a share of each spend into savings the user can reach
//! once a month.
//!
//! Implements sections 4.4, 5, 6.1 and 6.2 of `docs/architecture.md`.

#![no_std]

mod error;
mod events;
mod storage;

use loktin_common::calendar::{self, SECONDS_PER_DAY};
use loktin_common::target_savings::TargetSavingsApiClient;
use loktin_common::{fees, roles, ttl};
use soroban_sdk::{
    contract, contractimpl, contractmeta, contracttype, token, Address, BytesN, Env, MuxedAddress,
    Symbol, Vec,
};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_contract_utils::pausable::{self as pausable, Pausable};
use stellar_contract_utils::upgradeable::{self as upgradeable, Upgradeable};

pub use crate::error::Error;
pub use crate::events::{
    Enrolled, EnrollmentClosed, FeeRecipientSet, FeesClaimed, LoktinFeeSet, Paid, Saved,
    SettingsUpdated, Upgraded, Withdrawn,
};
pub use crate::storage::{
    DataKey, DayChange, Destination, Enrollment, EnrollmentRecord, SkimSettings, MAX_ENROLLMENTS,
    MAX_PERCENT_BPS, MIN_PERCENT_BPS,
};

contractmeta!(key = "binver", val = "0.3.0");

/// How a skim is worked out from a spend, before the wallet is checked
/// (P12, P13).
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SkimPreview {
    pub spent: i128,
    /// `floor(spent * percent_bps / 10,000)`, or 0 with no percentage.
    pub percent_part: i128,
    /// `(unit - spent % unit) % unit`, or 0 with no round-up unit.
    pub round_up_part: i128,
    /// The skim before trimming: the two parts added together, and never
    /// more than `spent`.
    pub skim: i128,
    /// How much the monthly cap trims off the skim.
    pub cap_trimmed: i128,
    /// The skim after the cap.
    pub capped: i128,
}

/// What one skim saved, and where it went (P14, S10).
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Saving {
    /// The skim before trimming.
    pub skim: i128,
    /// How much the monthly cap trimmed off.
    pub cap_trimmed: i128,
    /// How much the wallet could not cover.
    pub shortfall: i128,
    /// Saved to the Spend & Save balance.
    pub to_balance: i128,
    /// Saved into a Target Savings goal.
    pub to_goal: i128,
    /// The goal that received `to_goal`, when it is above zero.
    pub goal_id: Option<u64>,
}

/// How a withdrawal splits between its recipients. Spend & Save has no
/// penalty.
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Withdrawal {
    pub amount: i128,
    pub loktin_fee: i128,
    pub integrator_fee: i128,
    pub to_user: i128,
}

#[contract]
pub struct SpendSave;

#[contractimpl]
impl SpendSave {
    /// Sets up the instance. The token, Target Savings contract and yield
    /// source are fixed from here on (C7, C8).
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
        target_savings: Option<Address>,
        yield_source: Option<Address>,
    ) -> Result<(), Error> {
        if loktin_fee_bps > fees::MAX_LOKTIN_FEE_BPS {
            return Err(Error::RateAboveCap);
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
                target_savings,
                yield_source: None,
            },
        );
        upgradeable::set_schema_version(e, storage::SCHEMA_VERSION);
        ttl::extend_instance(e);
        Ok(())
    }

    /// Enrols `user` with `integrator` (P12, P13, P16, S9).
    #[allow(clippy::too_many_arguments)]
    pub fn enroll(
        e: &Env,
        user: Address,
        integrator: Address,
        integrator_fee_bps: u32,
        skim: SkimSettings,
        monthly_cap: Option<i128>,
        destination: Destination,
        withdrawal_day: u32,
    ) -> Result<(), Error> {
        user.require_auth();
        pausable::when_not_paused(e);
        let config = storage::config(e)?;
        if integrator_fee_bps > fees::MAX_INTEGRATOR_FEE_BPS {
            return Err(Error::RateAboveCap);
        }
        // Fees paid to this contract would be held with no record (C10).
        if integrator == e.current_contract_address() {
            return Err(Error::InvalidIntegrator);
        }
        check_settings(&config, &skim, monthly_cap, &destination, withdrawal_day)?;
        if storage::has_enrollment(e, &user, &integrator) {
            return Err(Error::AlreadyEnrolled);
        }
        let mut integrators = storage::user_integrators(e, &user);
        if integrators.len() >= MAX_ENROLLMENTS {
            return Err(Error::TooManyEnrollments);
        }

        let enrollment = Enrollment {
            user: user.clone(),
            integrator: integrator.clone(),
            integrator_fee_bps,
            loktin_fee_bps: config.loktin_fee_bps,
            skim,
            monthly_cap,
            destination,
            withdrawal_day,
            pending_day: DayChange::None,
            principal: 0,
            shares: 0,
            month_index: current_month(e)?,
            saved_this_month: 0,
            total_spent: 0,
            total_saved: 0,
        };
        storage::save_enrollment(e, &enrollment);
        integrators.push_back(integrator.clone());
        storage::set_user_integrators(e, &user, &integrators);
        ttl::extend_instance(e);

        Enrolled {
            user,
            integrator,
            integrator_fee_bps,
            loktin_fee_bps: config.loktin_fee_bps,
            skim,
            monthly_cap,
            destination,
            withdrawal_day,
        }
        .publish(e);
        Ok(())
    }

    /// Replaces the skim settings, cap and destination at once, and asks for
    /// a new withdrawal day from next month (P16, S9). Fee rates never
    /// change. Not blocked by pause (C4).
    pub fn update_settings(
        e: &Env,
        user: Address,
        integrator: Address,
        skim: SkimSettings,
        monthly_cap: Option<i128>,
        destination: Destination,
        withdrawal_day: u32,
    ) -> Result<(), Error> {
        user.require_auth();
        let config = storage::config(e)?;
        check_settings(&config, &skim, monthly_cap, &destination, withdrawal_day)?;
        let mut enrollment = storage::enrollment(e, &user, &integrator)?;
        let month = current_month(e)?;
        refresh(&mut enrollment, month);

        enrollment.skim = skim;
        enrollment.monthly_cap = monthly_cap;
        enrollment.destination = destination;
        // A second change in the same month replaces the pending one.
        enrollment.pending_day = if withdrawal_day == enrollment.withdrawal_day {
            DayChange::None
        } else {
            let from_month = month.checked_add(1).ok_or(Error::Overflow)?;
            DayChange::Pending(withdrawal_day, from_month)
        };
        storage::save_enrollment(e, &enrollment);
        ttl::extend_instance(e);

        SettingsUpdated {
            user,
            integrator,
            skim,
            monthly_cap,
            destination,
            withdrawal_day: enrollment.withdrawal_day,
            pending_day: enrollment.pending_day,
        }
        .publish(e);
        Ok(())
    }

    /// Pays `amount` from the user to `to`, a plain or muxed address, and
    /// saves the skim on it in the same call (P11). The payment never fails
    /// because of the skim (P14).
    pub fn pay_and_save(
        e: &Env,
        user: Address,
        integrator: Address,
        to: MuxedAddress,
        amount: i128,
    ) -> Result<Saving, Error> {
        user.require_auth();
        pausable::when_not_paused(e);
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let contract = e.current_contract_address();
        let payee = to.address();
        // A payment to this contract would be held with no record.
        if payee == contract {
            return Err(Error::InvalidPayee);
        }
        let config = storage::config(e)?;
        let mut enrollment = storage::enrollment(e, &user, &integrator)?;
        let token = token::TokenClient::new(e, &config.token);
        let balance = token.balance(&user);
        if balance < amount {
            return Err(Error::PaymentShortfall);
        }
        // What the wallet can still cover once the payment is made.
        let available = if payee == user {
            balance
        } else {
            balance - amount
        };

        let saving = save(e, &config, &mut enrollment, amount, available)?;
        storage::save_enrollment(e, &enrollment);
        ttl::extend_instance(e);

        token.transfer(&user, &to, &amount);
        if saving.to_balance > 0 {
            token.transfer(&user, &contract, &saving.to_balance);
        }

        Paid {
            user: user.clone(),
            integrator: integrator.clone(),
            to,
            amount,
        }
        .publish(e);
        publish_saved(e, user, integrator, amount, &saving);
        Ok(saving)
    }

    /// Saves the skim on a spend the user made by other means (P11).
    pub fn save_for_spend(
        e: &Env,
        user: Address,
        integrator: Address,
        spent: i128,
    ) -> Result<Saving, Error> {
        user.require_auth();
        pausable::when_not_paused(e);
        if spent <= 0 {
            return Err(Error::InvalidAmount);
        }
        let config = storage::config(e)?;
        let mut enrollment = storage::enrollment(e, &user, &integrator)?;
        let token = token::TokenClient::new(e, &config.token);
        let available = token.balance(&user);

        let saving = save(e, &config, &mut enrollment, spent, available)?;
        storage::save_enrollment(e, &enrollment);
        ttl::extend_instance(e);

        if saving.to_balance > 0 {
            let contract = e.current_contract_address();
            token.transfer(&user, &contract, &saving.to_balance);
        }

        publish_saved(e, user, integrator, spent, &saving);
        Ok(saving)
    }

    /// Withdraws `amount` from the balance inside the withdrawal window
    /// (P16, S9, R2) and pays the user's share. The integrator fee accrues
    /// to the integrator, and the Loktin fee to the current fee recipient,
    /// for each to claim with `claim_fees` (W63). Never blocked by pause
    /// (C4).
    pub fn withdraw(
        e: &Env,
        user: Address,
        integrator: Address,
        amount: i128,
    ) -> Result<Withdrawal, Error> {
        user.require_auth();
        let config = storage::config(e)?;
        let mut enrollment = storage::enrollment(e, &user, &integrator)?;
        let month = current_month(e)?;
        refresh(&mut enrollment, month);
        if !calendar::in_window(e.ledger().timestamp(), enrollment.withdrawal_day)? {
            return Err(Error::OutsideWindow);
        }
        let withdrawal = breakdown(&enrollment, amount)?;

        enrollment.principal = enrollment
            .principal
            .checked_sub(amount)
            .ok_or(Error::Overflow)?;
        enrollment.shares = enrollment.principal;
        storage::save_enrollment(e, &enrollment);
        storage::add_accrued_fees(e, &integrator, withdrawal.integrator_fee)?;
        storage::add_accrued_fees(e, &config.fee_recipient, withdrawal.loktin_fee)?;
        ttl::extend_instance(e);

        // The only transfer: no recipient of fees can block the user (S8).
        if withdrawal.to_user > 0 {
            token::TokenClient::new(e, &config.token).transfer(
                &e.current_contract_address(),
                &user,
                &withdrawal.to_user,
            );
        }

        Withdrawn {
            user,
            integrator,
            amount,
            loktin_fee: withdrawal.loktin_fee,
            integrator_fee: withdrawal.integrator_fee,
            to_user: withdrawal.to_user,
        }
        .publish(e);
        Ok(withdrawal)
    }

    /// Closes an enrolment whose balance is zero (S9).
    pub fn close(e: &Env, user: Address, integrator: Address) -> Result<(), Error> {
        user.require_auth();
        let enrollment = storage::enrollment(e, &user, &integrator)?;
        if enrollment.principal != 0 {
            return Err(Error::BalanceNotZero);
        }
        storage::remove_enrollment(e, &user, &integrator);
        let mut integrators = storage::user_integrators(e, &user);
        if let Some(index) = integrators.first_index_of(&integrator) {
            integrators.remove(index);
        }
        storage::set_user_integrators(e, &user, &integrators);
        ttl::extend_instance(e);

        EnrollmentClosed { user, integrator }.publish(e);
        Ok(())
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

    /// Returns an enrolment as stored.
    pub fn enrollment(e: &Env, user: Address, integrator: Address) -> Result<Enrollment, Error> {
        storage::enrollment(e, &user, &integrator)
    }

    /// Returns how a spend would be skimmed now, before the wallet is
    /// checked. Uses the same calculation as `pay_and_save` and
    /// `save_for_spend`.
    pub fn preview_skim(
        e: &Env,
        user: Address,
        integrator: Address,
        spent: i128,
    ) -> Result<SkimPreview, Error> {
        let mut enrollment = storage::enrollment(e, &user, &integrator)?;
        refresh(&mut enrollment, current_month(e)?);
        calculate(&enrollment, spent)
    }

    /// Returns how a withdrawal of `amount` would split. Does not check the
    /// withdrawal window.
    pub fn preview_withdraw(
        e: &Env,
        user: Address,
        integrator: Address,
        amount: i128,
    ) -> Result<Withdrawal, Error> {
        breakdown(&storage::enrollment(e, &user, &integrator)?, amount)
    }

    /// Returns the `(start, end)` of the current withdrawal window if one is
    /// open, otherwise of the next one, using the effective withdrawal day.
    /// `end` is the first second after the window.
    pub fn next_window(e: &Env, user: Address, integrator: Address) -> Result<(u64, u64), Error> {
        let mut enrollment = storage::enrollment(e, &user, &integrator)?;
        let now = e.ledger().timestamp();
        let month = current_month(e)?;
        refresh(&mut enrollment, month);
        let day = enrollment.withdrawal_day;
        let (start, end) = calendar::next_window(now, day)?;
        let DayChange::Pending(pending_day, from_month) = enrollment.pending_day else {
            return Ok((start, end));
        };
        if calendar::month_index(start)? < from_month {
            return Ok((start, end));
        }
        // The next window falls in the month the pending day takes over, so
        // move it to the pending day of that same month.
        let start = start
            .checked_sub(u64::from(day - 1) * SECONDS_PER_DAY)
            .and_then(|first| first.checked_add(u64::from(pending_day - 1) * SECONDS_PER_DAY))
            .ok_or(Error::Overflow)?;
        let end = start.checked_add(SECONDS_PER_DAY).ok_or(Error::Overflow)?;
        Ok((start, end))
    }

    /// Returns the token this instance holds.
    pub fn token(e: &Env) -> Result<Address, Error> {
        Ok(storage::config(e)?.token)
    }

    /// Returns the Loktin fee rate that new enrolments receive.
    pub fn loktin_fee_bps(e: &Env) -> Result<u32, Error> {
        Ok(storage::config(e)?.loktin_fee_bps)
    }

    /// Returns the address Loktin fees are paid to.
    pub fn fee_recipient(e: &Env) -> Result<Address, Error> {
        Ok(storage::config(e)?.fee_recipient)
    }

    /// Returns the Target Savings contract skims may go to, if any.
    pub fn target_savings(e: &Env) -> Result<Option<Address>, Error> {
        Ok(storage::config(e)?.target_savings)
    }

    /// Sets the Loktin fee rate for enrolments created from now on (R3,
    /// R6). Fee-admin only.
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
impl AccessControl for SpendSave {}

#[contractimpl(contracttrait)]
impl Pausable for SpendSave {
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
impl Upgradeable for SpendSave {
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

fn current_month(e: &Env) -> Result<u32, Error> {
    Ok(calendar::month_index(e.ledger().timestamp())?)
}

fn check_settings(
    config: &storage::Config,
    skim: &SkimSettings,
    monthly_cap: Option<i128>,
    destination: &Destination,
    withdrawal_day: u32,
) -> Result<(), Error> {
    let percent_ok = skim
        .percent_bps
        .is_none_or(|bps| (MIN_PERCENT_BPS..=MAX_PERCENT_BPS).contains(&bps));
    let unit_ok = skim.round_up_unit.is_none_or(|unit| unit > 0);
    let any_part = skim.percent_bps.is_some() || skim.round_up_unit.is_some();
    if !(percent_ok && unit_ok && any_part) {
        return Err(Error::InvalidSkim);
    }
    if monthly_cap.is_some_and(|cap| cap <= 0) {
        return Err(Error::InvalidCap);
    }
    calendar::check_day(withdrawal_day)?;
    if matches!(destination, Destination::Goal(_)) && config.target_savings.is_none() {
        return Err(Error::DestinationUnavailable);
    }
    Ok(())
}

/// Moves a pending withdrawal day that has become effective into
/// `withdrawal_day`, and starts a new month's count when the month has
/// changed (P13, P16).
fn refresh(enrollment: &mut Enrollment, month: u32) {
    if let DayChange::Pending(day, from_month) = enrollment.pending_day {
        if month >= from_month {
            enrollment.withdrawal_day = day;
            enrollment.pending_day = DayChange::None;
        }
    }
    if enrollment.month_index != month {
        enrollment.month_index = month;
        enrollment.saved_this_month = 0;
    }
}

/// The one skim calculation (P12, P13), used by `preview_skim`,
/// `pay_and_save` and `save_for_spend`. Expects an enrolment already
/// refreshed for the current month.
fn calculate(enrollment: &Enrollment, spent: i128) -> Result<SkimPreview, Error> {
    if spent <= 0 {
        return Err(Error::InvalidAmount);
    }
    let percent_part = match enrollment.skim.percent_bps {
        Some(bps) => fees::bps_of(spent, bps)?,
        None => 0,
    };
    let round_up_part = match enrollment.skim.round_up_unit {
        Some(unit) => {
            let rest = spent.checked_rem(unit).ok_or(Error::Overflow)?;
            unit.checked_sub(rest)
                .and_then(|up| up.checked_rem(unit))
                .ok_or(Error::Overflow)?
        }
        None => 0,
    };
    // A skim never exceeds the spend it is taken from (P12). The sum can only
    // pass `i128::MAX` when it is far above the spend, so saturating before
    // the cut changes nothing.
    let skim = percent_part.saturating_add(round_up_part).min(spent);
    let capped = match enrollment.monthly_cap {
        Some(cap) => {
            let room = cap
                .checked_sub(enrollment.saved_this_month)
                .ok_or(Error::Overflow)?
                .max(0);
            skim.min(room)
        }
        None => skim,
    };
    Ok(SkimPreview {
        spent,
        percent_part,
        round_up_part,
        skim,
        cap_trimmed: skim - capped,
        capped,
    })
}

/// Works out the skim on `spent`, trims it to what the wallet can cover,
/// deposits the goal's share into Target Savings, and records the rest in
/// the enrolment. The goal deposit is the one call made before this
/// contract's own state is written: where the skim lands depends on its
/// result.
fn save(
    e: &Env,
    config: &storage::Config,
    enrollment: &mut Enrollment,
    spent: i128,
    available: i128,
) -> Result<Saving, Error> {
    refresh(enrollment, current_month(e)?);
    let preview = calculate(enrollment, spent)?;
    let saved = preview.capped.min(available.max(0));
    let shortfall = preview.capped - saved;
    let (to_goal, goal_id) = deposit_to_goal(e, config, enrollment, saved);
    let to_balance = saved - to_goal;

    enrollment.principal = enrollment
        .principal
        .checked_add(to_balance)
        .ok_or(Error::Overflow)?;
    // One share per unit of principal while no yield source exists (C7).
    enrollment.shares = enrollment.principal;
    enrollment.saved_this_month = enrollment
        .saved_this_month
        .checked_add(saved)
        .ok_or(Error::Overflow)?;
    enrollment.total_spent = enrollment
        .total_spent
        .checked_add(spent)
        .ok_or(Error::Overflow)?;
    enrollment.total_saved = enrollment
        .total_saved
        .checked_add(saved)
        .ok_or(Error::Overflow)?;
    Ok(Saving {
        skim: preview.skim,
        cap_trimmed: preview.cap_trimmed,
        shortfall,
        to_balance,
        to_goal,
        goal_id,
    })
}

/// Deposits up to `saved` into the enrolment's goal destination, if it can
/// take it, and returns how much went in (S10). Any refusal from Target
/// Savings sends the whole skim to the balance instead.
fn deposit_to_goal(
    e: &Env,
    config: &storage::Config,
    enrollment: &Enrollment,
    saved: i128,
) -> (i128, Option<u64>) {
    let (Destination::Goal(goal_id), Some(target_savings)) =
        (enrollment.destination, &config.target_savings)
    else {
        return (0, None);
    };
    if saved <= 0 {
        return (0, None);
    }
    let client = TargetSavingsApiClient::new(e, target_savings);
    let Ok(Ok(goal)) = client.try_goal(&goal_id) else {
        return (0, None);
    };
    let needed = goal.target.saturating_sub(goal.principal);
    if goal.owner != enrollment.user || e.ledger().timestamp() > goal.deadline || needed <= 0 {
        return (0, None);
    }
    let part = saved.min(needed);
    match client.try_deposit(&enrollment.user, &goal_id, &part) {
        Ok(Ok(())) => (part, Some(goal_id)),
        _ => (0, None),
    }
}

fn breakdown(enrollment: &Enrollment, amount: i128) -> Result<Withdrawal, Error> {
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    if amount > enrollment.principal {
        return Err(Error::ExceedsBalance);
    }
    let parts = fees::withdrawal_breakdown(
        amount,
        0,
        enrollment.loktin_fee_bps,
        enrollment.integrator_fee_bps,
    )?;
    Ok(Withdrawal {
        amount,
        loktin_fee: parts.loktin_fee,
        integrator_fee: parts.integrator_fee,
        to_user: parts.to_user,
    })
}

fn publish_saved(e: &Env, user: Address, integrator: Address, spent: i128, saving: &Saving) {
    Saved {
        user,
        integrator,
        spent,
        skim: saving.skim,
        cap_trimmed: saving.cap_trimmed,
        shortfall: saving.shortfall,
        to_balance: saving.to_balance,
        to_goal: saving.to_goal,
        goal_id: saving.goal_id,
    }
    .publish(e);
}
