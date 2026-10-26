mod common;

use common::{Setup, DAY, MIN_CADENCE, START, WEEK};
use loktin_target_savings::{Error, Goal, GoalCreated, WithdrawalRule, MAX_OPEN_GOALS};
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{Address, Event as _, InvokeError};

#[allow(clippy::type_complexity)]
fn try_create(
    s: &Setup,
    target: i128,
    deadline: u64,
    cadence: u64,
    deposit_size: i128,
    rule: WithdrawalRule,
    integrator_fee_bps: u32,
) -> Result<Result<u64, soroban_sdk::Error>, Result<Error, InvokeError>> {
    s.contract.try_create_goal(
        &s.owner,
        &target,
        &deadline,
        &cadence,
        &deposit_size,
        &rule,
        &s.integrator,
        &integrator_fee_bps,
        &None,
    )
}

/// The id the owner's first goal receives.
fn first_id(s: &Setup) -> u64 {
    common::goal_id(&s.env, &s.owner, 0)
}

#[test]
fn creates_goal_and_emits_event() {
    let s = common::setup_with_fee(100);
    s.env.mock_all_auths();
    let id = s.contract.create_goal(
        &s.owner,
        &10_000,
        &(START + 10 * WEEK),
        &WEEK,
        &1_000,
        &WithdrawalRule::Penalty(500),
        &s.integrator,
        &50,
        &None,
    );
    assert_eq!(id, first_id(&s));
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.contract.address),
        [GoalCreated {
            goal_id: id,
            owner: s.owner.clone(),
            integrator: s.integrator.clone(),
            target: 10_000,
            deadline: START + 10 * WEEK,
            cadence: WEEK,
            deposit_size: 1_000,
            rule: WithdrawalRule::Penalty(500),
            start: START,
            loktin_fee_bps: 100,
            integrator_fee_bps: 50,
        }
        .to_xdr(&s.env, &s.contract.address)]
    );
    assert_eq!(
        s.contract.goal(&id),
        Goal {
            id,
            owner: s.owner.clone(),
            integrator: s.integrator.clone(),
            integrator_fee_bps: 50,
            loktin_fee_bps: 100,
            target: 10_000,
            deadline: START + 10 * WEEK,
            cadence: WEEK,
            deposit_size: 1_000,
            rule: WithdrawalRule::Penalty(500),
            start: START,
            principal: 0,
            shares: 0,
            last_collected_period: 0,
            missed_count: 0,
        }
    );
    assert_eq!(s.goals_created(&s.owner), 1);
    assert_eq!(s.contract.user_goals(&s.owner).len(), 1);
}

#[test]
fn ids_follow_the_owner_counter() {
    let s = common::setup();
    for counter in 0..3 {
        assert_eq!(
            s.create_default(WithdrawalRule::Lock),
            common::goal_id(&s.env, &s.owner, counter)
        );
    }
}

#[test]
fn allowance_is_approved_in_the_same_call() {
    let s = common::setup();
    let allowance = s.allowance(5_000);
    s.contract.create_goal(
        &s.owner,
        &10_000,
        &(START + 10 * WEEK),
        &WEEK,
        &1_000,
        &WithdrawalRule::Lock,
        &s.integrator,
        &0,
        &allowance,
    );
    assert_eq!(s.token.allowance(&s.owner, &s.contract.address), 5_000);
}

#[test]
fn rejects_target_not_above_zero() {
    let s = common::setup();
    for target in [0, -1] {
        assert_eq!(
            try_create(&s, target, START + WEEK, WEEK, 1, WithdrawalRule::Lock, 0),
            Err(Ok(Error::InvalidTarget))
        );
    }
}

#[test]
fn rejects_deposit_size_not_above_zero() {
    let s = common::setup();
    for size in [0, -1] {
        assert_eq!(
            try_create(&s, 1, START + WEEK, WEEK, size, WithdrawalRule::Lock, 0),
            Err(Ok(Error::InvalidDeposit))
        );
    }
}

#[test]
fn rejects_deadline_not_after_now() {
    let s = common::setup();
    for deadline in [START, START - 1, 0] {
        assert_eq!(
            try_create(&s, 1, deadline, WEEK, 1, WithdrawalRule::Lock, 0),
            Err(Ok(Error::InvalidDeadline))
        );
    }
}

#[test]
fn cadence_exactly_at_minimum_is_accepted() {
    let s = common::setup();
    assert_eq!(
        try_create(&s, 1, START + DAY, MIN_CADENCE, 1, WithdrawalRule::Lock, 0),
        Ok(Ok(first_id(&s)))
    );
}

#[test]
fn rejects_cadence_below_minimum() {
    let s = common::setup();
    assert_eq!(
        try_create(
            &s,
            1,
            START + WEEK,
            MIN_CADENCE - 1,
            1,
            WithdrawalRule::Lock,
            0
        ),
        Err(Ok(Error::CadenceTooShort))
    );
}

#[test]
fn first_period_due_exactly_at_deadline_is_accepted() {
    let s = common::setup();
    assert_eq!(
        try_create(&s, 1, START + WEEK, WEEK, 1, WithdrawalRule::Lock, 0),
        Ok(Ok(first_id(&s)))
    );
}

#[test]
fn rejects_first_period_after_deadline() {
    let s = common::setup();
    assert_eq!(
        try_create(&s, 1, START + WEEK - 1, WEEK, 1, WithdrawalRule::Lock, 0),
        Err(Ok(Error::NoPeriodBeforeDeadline))
    );
}

#[test]
fn rejects_cadence_that_overflows() {
    let s = common::setup();
    assert_eq!(
        try_create(&s, 1, u64::MAX, u64::MAX, 1, WithdrawalRule::Lock, 0),
        Err(Ok(Error::Overflow))
    );
}

#[test]
fn penalty_at_cap_is_accepted_and_above_is_rejected() {
    let s = common::setup();
    assert_eq!(
        try_create(
            &s,
            1,
            START + WEEK,
            WEEK,
            1,
            WithdrawalRule::Penalty(1_000),
            0
        ),
        Ok(Ok(first_id(&s)))
    );
    assert_eq!(
        try_create(
            &s,
            1,
            START + WEEK,
            WEEK,
            1,
            WithdrawalRule::Penalty(1_001),
            0
        ),
        Err(Ok(Error::RateAboveCap))
    );
}

#[test]
fn integrator_fee_at_cap_is_accepted_and_above_is_rejected() {
    let s = common::setup();
    assert_eq!(
        try_create(&s, 1, START + WEEK, WEEK, 1, WithdrawalRule::Lock, 100),
        Ok(Ok(first_id(&s)))
    );
    assert_eq!(
        try_create(&s, 1, START + WEEK, WEEK, 1, WithdrawalRule::Lock, 101),
        Err(Ok(Error::RateAboveCap))
    );
}

#[test]
fn twentieth_goal_is_accepted_and_twenty_first_is_rejected() {
    let s = common::setup();
    for counter in 0..u64::from(MAX_OPEN_GOALS) {
        assert_eq!(
            s.create_default(WithdrawalRule::Lock),
            common::goal_id(&s.env, &s.owner, counter)
        );
    }
    assert_eq!(s.contract.user_goals(&s.owner).len(), MAX_OPEN_GOALS);
    assert_eq!(
        try_create(&s, 1, START + WEEK, WEEK, 1, WithdrawalRule::Lock, 0),
        Err(Ok(Error::TooManyGoals))
    );
    // Another owner is not affected.
    let other = Address::generate(&s.env);
    assert_eq!(
        s.contract.try_create_goal(
            &other,
            &1,
            &(START + WEEK),
            &WEEK,
            &1,
            &WithdrawalRule::Lock,
            &s.integrator,
            &0,
            &None,
        ),
        Ok(Ok(common::goal_id(&s.env, &other, 0)))
    );
    // Closing a goal frees a slot. The counter never goes back, so the new
    // goal gets a new id.
    s.contract.withdraw(&s.owner, &first_id(&s));
    assert_eq!(
        try_create(&s, 1, START + WEEK, WEEK, 1, WithdrawalRule::Lock, 0),
        Ok(Ok(common::goal_id(
            &s.env,
            &s.owner,
            u64::from(MAX_OPEN_GOALS)
        )))
    );
}

#[test]
fn rejects_this_contract_as_integrator() {
    let s = common::setup();
    assert_eq!(
        s.contract.try_create_goal(
            &s.owner,
            &10_000,
            &(START + 10 * WEEK),
            &WEEK,
            &1_000,
            &WithdrawalRule::Penalty(1_000),
            &s.contract.address,
            &100,
            &None,
        ),
        Err(Ok(Error::InvalidIntegrator))
    );
    assert_eq!(s.contract.user_goals(&s.owner).len(), 0);
    assert_eq!(s.goals_created(&s.owner), 0);
}

#[test]
fn rejects_when_config_is_missing() {
    let s = common::setup();
    s.env.as_contract(&s.contract.address, || {
        s.env
            .storage()
            .instance()
            .remove(&loktin_target_savings::DataKey::Config);
    });
    assert_eq!(
        try_create(&s, 1, START + WEEK, WEEK, 1, WithdrawalRule::Lock, 0),
        Err(Ok(Error::ConfigMissing))
    );
}
