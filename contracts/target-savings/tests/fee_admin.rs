mod common;

use common::{START, WEEK};
use loktin_target_savings::{Error, FeeRecipientSet, LoktinFeeSet, WithdrawalRule};
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{Address, Event as _};

#[test]
fn sets_loktin_fee_and_emits_event() {
    let s = common::setup();
    s.contract.set_loktin_fee(&100, &s.fee_admin);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.contract.address),
        [LoktinFeeSet {
            loktin_fee_bps: 100
        }
        .to_xdr(&s.env, &s.contract.address)]
    );
    assert_eq!(s.contract.loktin_fee_bps(), 100);
}

#[test]
fn rejects_loktin_fee_above_cap() {
    let s = common::setup();
    assert_eq!(
        s.contract.try_set_loktin_fee(&101, &s.fee_admin),
        Err(Ok(Error::RateAboveCap))
    );
    assert_eq!(s.contract.loktin_fee_bps(), 0);
}

#[test]
fn new_rate_applies_only_to_new_goals() {
    let s = common::setup();
    let before = s.create_default(WithdrawalRule::Lock);
    s.contract.set_loktin_fee(&100, &s.fee_admin);
    let after = s.contract.create_goal(
        &s.owner,
        &1,
        &(START + WEEK),
        &WEEK,
        &1,
        &WithdrawalRule::Lock,
        &s.integrator,
        &0,
        &None,
    );
    s.contract.set_loktin_fee(&0, &s.fee_admin);
    assert_eq!(s.contract.goal(&before).loktin_fee_bps, 0);
    assert_eq!(s.contract.goal(&after).loktin_fee_bps, 100);
}

#[test]
fn sets_fee_recipient_and_emits_event() {
    let s = common::setup();
    let recipient = Address::generate(&s.env);
    s.contract.set_fee_recipient(&recipient, &s.fee_admin);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.contract.address),
        [FeeRecipientSet {
            fee_recipient: recipient.clone(),
        }
        .to_xdr(&s.env, &s.contract.address)]
    );
    assert_eq!(s.contract.fee_recipient(), recipient);
}

#[test]
fn rejects_this_contract_as_fee_recipient() {
    let s = common::setup();
    assert_eq!(
        s.contract
            .try_set_fee_recipient(&s.contract.address, &s.fee_admin),
        Err(Ok(Error::InvalidFeeRecipient))
    );
    assert_eq!(s.contract.fee_recipient(), s.fee_recipient);
}

#[test]
fn setters_report_missing_configuration() {
    let s = common::setup();
    s.env.as_contract(&s.contract.address, || {
        s.env
            .storage()
            .instance()
            .remove(&loktin_target_savings::DataKey::Config);
    });
    assert_eq!(
        s.contract.try_set_loktin_fee(&1, &s.fee_admin),
        Err(Ok(Error::ConfigMissing))
    );
    let recipient = Address::generate(&s.env);
    assert_eq!(
        s.contract.try_set_fee_recipient(&recipient, &s.fee_admin),
        Err(Ok(Error::ConfigMissing))
    );
}
