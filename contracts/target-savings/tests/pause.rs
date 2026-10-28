mod common;

use common::{START, WEEK};
use loktin_target_savings::WithdrawalRule;
use soroban_sdk::testutils::Events as _;
use soroban_sdk::{Event as _, InvokeError};
use stellar_contract_utils::pausable::{Paused, Unpaused};

const ENFORCED_PAUSE: u32 = 1000;
const EXPECTED_PAUSE: u32 = 1001;

fn refused_by_pause<T>(
    result: Result<T, Result<loktin_target_savings::Error, InvokeError>>,
) -> bool {
    matches!(result, Err(Err(InvokeError::Contract(ENFORCED_PAUSE))))
}

#[test]
fn pause_and_unpause_emit_events() {
    let s = common::setup();
    s.contract.pause(&s.pauser);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.contract.address),
        [Paused {}.to_xdr(&s.env, &s.contract.address)]
    );
    assert!(s.contract.paused());
    s.contract.unpause(&s.pauser);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.contract.address),
        [Unpaused {}.to_xdr(&s.env, &s.contract.address)]
    );
    assert!(!s.contract.paused());
}

#[test]
fn pausing_twice_and_unpausing_when_running_are_refused() {
    let s = common::setup();
    assert_eq!(
        s.contract.try_unpause(&s.pauser),
        Err(Ok(soroban_sdk::Error::from_contract_error(EXPECTED_PAUSE)))
    );
    s.contract.pause(&s.pauser);
    assert_eq!(
        s.contract.try_pause(&s.pauser),
        Err(Ok(soroban_sdk::Error::from_contract_error(ENFORCED_PAUSE)))
    );
}

#[test]
fn pause_blocks_create_deposit_and_collect() {
    let s = common::setup();
    s.mint(&s.owner, 10_000);
    let id = s.contract.create_goal(
        &s.owner,
        &10_000,
        &(START + 10 * WEEK),
        &WEEK,
        &1_000,
        &WithdrawalRule::Lock,
        &s.integrator,
        &0,
        &s.allowance(10_000),
    );
    s.set_time(START + WEEK);
    s.contract.pause(&s.pauser);
    assert!(refused_by_pause(s.contract.try_create_goal(
        &s.owner,
        &1,
        &(START + 2 * WEEK),
        &WEEK,
        &1,
        &WithdrawalRule::Lock,
        &s.integrator,
        &0,
        &None,
    )));
    assert!(refused_by_pause(s.contract.try_deposit(&s.owner, &id, &1)));
    assert!(refused_by_pause(s.contract.try_collect(&id)));
    // Everything works again after unpausing.
    s.contract.unpause(&s.pauser);
    s.contract.collect(&id);
    s.contract.deposit(&s.owner, &id, &1);
}

#[test]
fn pause_never_blocks_withdraw_or_reads() {
    let s = common::setup();
    s.mint(&s.owner, 5_000);
    let id = s.create_default(WithdrawalRule::Lock);
    s.contract.deposit(&s.owner, &id, &5_000);
    s.contract.pause(&s.pauser);
    assert_eq!(s.contract.goal(&id).principal, 5_000);
    assert_eq!(s.contract.user_goals(&s.owner).len(), 1);
    assert_eq!(s.contract.token(), s.token.address);
    assert_eq!(s.contract.loktin_fee_bps(), 0);
    assert_eq!(s.contract.fee_recipient(), s.fee_recipient);
    assert_eq!(s.contract.min_cadence(), common::MIN_CADENCE);
    // The lock rule still applies while paused.
    s.set_time(START + 10 * WEEK);
    assert_eq!(s.contract.preview_withdraw(&id).to_user, 5_000);
    assert_eq!(s.contract.withdraw(&s.owner, &id).to_user, 5_000);
    assert_eq!(s.token.balance(&s.owner), 5_000);
}
