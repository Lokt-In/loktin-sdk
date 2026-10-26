mod common;

use loktin_target_savings::{Error, WithdrawalRule};
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
fn user_goals_lists_only_open_goals_in_creation_order() {
    let s = common::setup();
    let ids: std::vec::Vec<u64> = (0..5)
        .map(|_| s.create_default(WithdrawalRule::Lock))
        .collect();
    s.contract.withdraw(&s.owner, &ids[1]);
    s.contract.withdraw(&s.owner, &ids[3]);
    let open: std::vec::Vec<u64> = s
        .contract
        .user_goals(&s.owner)
        .iter()
        .map(|g| g.id)
        .collect();
    assert_eq!(open, [ids[0], ids[2], ids[4]]);
}

#[test]
fn configuration_reads() {
    let s = common::setup();
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
}
