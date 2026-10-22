mod common;

use common::{percent, TODAY};
use loktin_spend_save::Destination;
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{Address, Event as _, InvokeError, MuxedAddress};
use stellar_contract_utils::pausable::{Paused, Unpaused};

const ENFORCED_PAUSE: u32 = 1000;

fn refused_by_pause<T>(result: Result<T, Result<loktin_spend_save::Error, InvokeError>>) -> bool {
    matches!(result, Err(Err(InvokeError::Contract(ENFORCED_PAUSE))))
}

#[test]
fn spend_save_pause_and_unpause_emit_events() {
    let s = common::setup();
    s.contract.pause(&s.pauser);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.contract.address),
        [Paused {}.to_xdr(&s.env, &s.contract.address)]
    );
    s.contract.unpause(&s.pauser);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.contract.address),
        [Unpaused {}.to_xdr(&s.env, &s.contract.address)]
    );
}

#[test]
fn pause_blocks_enrol_pay_and_save() {
    let s = common::setup();
    s.mint(&s.user, 1_000);
    s.enroll_default();
    s.contract.pause(&s.pauser);
    let other = Address::generate(&s.env);
    assert!(refused_by_pause(s.contract.try_enroll(
        &s.user,
        &other,
        &0,
        &percent(100),
        &None,
        &Destination::Balance,
        &TODAY,
    )));
    let to = MuxedAddress::from(&s.payee);
    assert!(refused_by_pause(s.contract.try_pay_and_save(
        &s.user,
        &s.integrator,
        &to,
        &10
    )));
    assert!(refused_by_pause(s.contract.try_save_for_spend(
        &s.user,
        &s.integrator,
        &10
    )));
    s.contract.unpause(&s.pauser);
    s.contract.save_for_spend(&s.user, &s.integrator, &10);
}

#[test]
fn pause_never_blocks_withdraw_close_settings_or_reads() {
    let s = common::setup();
    s.mint(&s.user, 1_000);
    s.enroll_default();
    s.contract.save_for_spend(&s.user, &s.integrator, &1_000);
    s.contract.pause(&s.pauser);
    s.contract.update_settings(
        &s.user,
        &s.integrator,
        &percent(200),
        &Some(50),
        &Destination::Balance,
        &TODAY,
    );
    assert_eq!(
        s.contract.preview_skim(&s.user, &s.integrator, &100).skim,
        2
    );
    assert_eq!(s.contract.enrollment(&s.user, &s.integrator).principal, 100);
    assert_eq!(
        s.contract
            .preview_withdraw(&s.user, &s.integrator, &100)
            .to_user,
        100
    );
    s.contract.next_window(&s.user, &s.integrator);
    assert_eq!(s.contract.token(), s.token.address);
    s.contract.withdraw(&s.user, &s.integrator, &100);
    s.contract.close(&s.user, &s.integrator);
    assert_eq!(s.token.balance(&s.user), 1_000);
}
