mod common;

use common::{START, WEEK};
use loktin_target_savings::{Error, WithdrawalRule, MAX_PAGE};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

#[test]
fn goal_and_user_goals() {
    let s = common::setup();
    assert_eq!(s.contract.try_goal(&1), Err(Ok(Error::GoalNotFound)));
    assert_eq!(s.contract.user_goals(&s.owner).len(), 0);
    let id = s.create_default(WithdrawalRule::Lock);
    assert_eq!(s.contract.goal(&id).owner, s.owner);
    let goals = s.contract.user_goals(&s.owner);
    assert_eq!(goals.len(), 1);
    assert_eq!(goals.get_unchecked(0), s.contract.goal(&id));
    let stranger = Address::generate(&s.env);
    assert_eq!(s.contract.user_goals(&stranger).len(), 0);
}

#[test]
fn open_goals_pages_and_skips_closed_goals() {
    let s = common::setup();
    for _ in 0..5 {
        s.create_default(WithdrawalRule::Lock);
    }
    s.contract.withdraw(&s.owner, &2);
    s.contract.withdraw(&s.owner, &4);
    let ids = |from: u64, limit: u32| -> std::vec::Vec<u64> {
        s.contract
            .open_goals(&from, &limit)
            .iter()
            .map(|g| g.id)
            .collect()
    };
    assert_eq!(ids(1, 50), [1, 3, 5]);
    assert_eq!(ids(1, 1), [1]);
    assert_eq!(ids(2, 2), [3]);
    assert_eq!(ids(0, 3), [1]);
    assert_eq!(ids(6, 50), std::vec::Vec::<u64>::new());
    assert_eq!(ids(u64::MAX, 50), std::vec::Vec::<u64>::new());
}

#[test]
fn open_goals_limit_bounds() {
    let s = common::setup();
    for _ in 0..20 {
        s.create_default(WithdrawalRule::Lock);
    }
    let other = Address::generate(&s.env);
    for _ in 0..20 {
        s.contract.create_goal(
            &other,
            &1,
            &(START + WEEK),
            &WEEK,
            &1,
            &WithdrawalRule::Lock,
            &s.integrator,
            &0,
            &None,
        );
    }
    let third = Address::generate(&s.env);
    for _ in 0..20 {
        s.contract.create_goal(
            &third,
            &1,
            &(START + WEEK),
            &WEEK,
            &1,
            &WithdrawalRule::Lock,
            &s.integrator,
            &0,
            &None,
        );
    }
    assert_eq!(s.contract.open_goals(&1, &MAX_PAGE).len(), 50);
    assert_eq!(s.contract.open_goals(&1, &1).len(), 1);
    assert_eq!(
        s.contract.try_open_goals(&1, &0),
        Err(Ok(Error::InvalidLimit))
    );
    assert_eq!(
        s.contract.try_open_goals(&1, &(MAX_PAGE + 1)),
        Err(Ok(Error::InvalidLimit))
    );
}

#[test]
fn next_id_and_configuration_reads() {
    let s = common::setup();
    assert_eq!(s.contract.next_id(), 1);
    s.create_default(WithdrawalRule::Lock);
    assert_eq!(s.contract.next_id(), 2);
    assert_eq!(s.contract.token(), s.token.address);
    assert_eq!(s.contract.loktin_fee_bps(), 0);
    assert_eq!(s.contract.fee_recipient(), s.fee_recipient);
    assert_eq!(s.contract.min_cadence(), common::MIN_CADENCE);
}

#[test]
fn preview_withdraw_rejects_unknown_goal() {
    let s = common::setup();
    assert_eq!(
        s.contract.try_preview_withdraw(&1),
        Err(Ok(Error::GoalNotFound))
    );
}

#[test]
fn reads_report_missing_configuration() {
    let s = common::setup();
    s.create_default(WithdrawalRule::Lock);
    s.env.as_contract(&s.contract.address, || {
        s.env
            .storage()
            .instance()
            .remove(&loktin_target_savings::DataKey::Config);
        s.env
            .storage()
            .instance()
            .remove(&loktin_target_savings::DataKey::NextId);
    });
    assert_eq!(s.contract.try_token(), Err(Ok(Error::ConfigMissing)));
    assert_eq!(
        s.contract.try_loktin_fee_bps(),
        Err(Ok(Error::ConfigMissing))
    );
    assert_eq!(
        s.contract.try_fee_recipient(),
        Err(Ok(Error::ConfigMissing))
    );
    assert_eq!(s.contract.try_min_cadence(), Err(Ok(Error::ConfigMissing)));
    assert_eq!(s.contract.try_next_id(), Err(Ok(Error::ConfigMissing)));
    assert_eq!(
        s.contract.try_open_goals(&1, &1),
        Err(Ok(Error::ConfigMissing))
    );
}
