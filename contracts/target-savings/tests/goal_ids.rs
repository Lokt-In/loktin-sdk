//! W75: goal ids come from the owner and the owner's own counter, so goal
//! creations by different owners never share a storage entry.

mod common;

use common::{goal_id, Setup, START, WEEK};
use loktin_target_savings::{DataKey, Error, Goal, GoalRecord, WithdrawalRule, MAX_ID_ATTEMPTS};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

/// Stores a goal of `owner` under `id` directly, as if that id were taken.
fn occupy(s: &Setup, owner: &Address, id: u64) {
    let goal = Goal {
        id,
        owner: owner.clone(),
        integrator: s.integrator.clone(),
        integrator_fee_bps: 0,
        loktin_fee_bps: 0,
        target: 1,
        deadline: START + WEEK,
        cadence: WEEK,
        deposit_size: 1,
        rule: WithdrawalRule::Lock,
        start: START,
        principal: 0,
        shares: 0,
        last_collected_period: 0,
        missed_count: 0,
    };
    s.env.as_contract(&s.contract.address, || {
        s.env
            .storage()
            .persistent()
            .set(&DataKey::Goal(id), &GoalRecord::V1(goal));
    });
}

#[test]
fn ids_are_deterministic_and_differ_across_owners_and_counters() {
    // Two separate environments generate the same owner address, and give
    // its first goal the same id.
    let first = common::setup();
    let second = common::setup();
    assert_eq!(first.owner, second.owner);
    let id = first.create_default(WithdrawalRule::Lock);
    assert_eq!(second.create_default(WithdrawalRule::Lock), id);
    assert_eq!(id, goal_id(&first.env, &first.owner, 0));

    let other = Address::generate(&first.env);
    assert_ne!(goal_id(&first.env, &other, 0), id);
    assert_ne!(goal_id(&first.env, &first.owner, 1), id);
    assert_ne!(
        goal_id(&first.env, &first.owner, 1),
        goal_id(&first.env, &other, 1)
    );
}

#[test]
fn the_counter_grows_by_one_and_never_goes_back() {
    let s = common::setup();
    assert_eq!(s.goals_created(&s.owner), 0);
    let ids: std::vec::Vec<u64> = (0..3)
        .map(|_| s.create_default(WithdrawalRule::Lock))
        .collect();
    assert_eq!(s.goals_created(&s.owner), 3);
    for id in &ids {
        s.contract.withdraw(&s.owner, id);
    }
    // Closing goals leaves the counter alone, so no id is ever reused.
    assert_eq!(s.goals_created(&s.owner), 3);
    let next = s.create_default(WithdrawalRule::Lock);
    assert_eq!(next, goal_id(&s.env, &s.owner, 3));
    assert!(!ids.contains(&next));
    assert_eq!(s.goals_created(&s.owner), 4);
    // Another owner's counter is its own.
    let other = Address::generate(&s.env);
    assert_eq!(s.goals_created(&other), 0);
}

#[test]
fn a_taken_id_moves_to_the_next_counter_value() {
    let s = common::setup();
    let taken = goal_id(&s.env, &s.owner, 0);
    let stranger = Address::generate(&s.env);
    occupy(&s, &stranger, taken);

    let id = s.create_default(WithdrawalRule::Lock);
    assert_eq!(id, goal_id(&s.env, &s.owner, 1));
    // The counter is stored past the value that produced the id.
    assert_eq!(s.goals_created(&s.owner), 2);
    // The goal already under the taken id is untouched.
    assert_eq!(s.contract.goal(&taken).owner, stranger);
    assert_eq!(s.contract.goal(&id).owner, s.owner);
}

#[test]
fn eight_taken_ids_give_goal_id_unavailable() {
    let s = common::setup();
    let stranger = Address::generate(&s.env);
    for counter in 0..u64::from(MAX_ID_ATTEMPTS) {
        occupy(&s, &stranger, goal_id(&s.env, &s.owner, counter));
    }
    assert_eq!(
        s.contract.try_create_goal(
            &s.owner,
            &10_000,
            &(START + 10 * WEEK),
            &WEEK,
            &1_000,
            &WithdrawalRule::Lock,
            &s.integrator,
            &0,
            &None,
        ),
        Err(Ok(Error::GoalIdUnavailable))
    );
    assert_eq!(s.goals_created(&s.owner), 0);
    assert_eq!(s.contract.user_goals(&s.owner).len(), 0);

    // With only seven taken, the eighth try succeeds.
    let other = Address::generate(&s.env);
    for counter in 0..u64::from(MAX_ID_ATTEMPTS) - 1 {
        occupy(&s, &stranger, goal_id(&s.env, &other, counter));
    }
    let id = s.contract.create_goal(
        &other,
        &10_000,
        &(START + 10 * WEEK),
        &WEEK,
        &1_000,
        &WithdrawalRule::Lock,
        &s.integrator,
        &0,
        &None,
    );
    assert_eq!(id, goal_id(&s.env, &other, u64::from(MAX_ID_ATTEMPTS) - 1));
    assert_eq!(s.goals_created(&other), u64::from(MAX_ID_ATTEMPTS));
}
