mod common;

use common::{percent, Setup, DAY, START, TODAY};
use loktin_spend_save::{Destination, Error, Withdrawal, Withdrawn};
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{Address, Event as _};

/// An enrolment holding 1,000, with a 1% integrator fee on an instance
/// charging 1%, withdrawing on the 22nd.
fn funded<'a>() -> Setup<'a> {
    let s = common::setup_with_fee(100);
    s.env.mock_all_auths();
    s.mint(&s.user, 10_000);
    s.contract.enroll(
        &s.user,
        &s.integrator,
        &100,
        &percent(1_000),
        &None,
        &Destination::Balance,
        &TODAY,
    );
    s.contract.save_for_spend(&s.user, &s.integrator, &10_000);
    s
}

/// Only the user was paid: the integrator and the fee recipient received
/// nothing, their fees accrued, and the contract still holds them alongside
/// the remaining balance (W63).
fn assert_accrued(s: &Setup, recipient: &Address, integrator_fee: i128, loktin_fee: i128) {
    assert_eq!(s.token.balance(&s.integrator), 0);
    assert_eq!(s.token.balance(recipient), 0);
    assert_eq!(s.contract.accrued_fees(&s.integrator), integrator_fee);
    assert_eq!(s.contract.accrued_fees(recipient), loktin_fee);
    assert_eq!(
        s.token.balance(&s.contract.address),
        s.principal() + integrator_fee + loktin_fee
    );
}

#[test]
fn withdraws_with_fees_and_emits_event() {
    let s = funded();
    let expected = Withdrawal {
        amount: 600,
        loktin_fee: 6,
        integrator_fee: 6,
        to_user: 588,
    };
    assert_eq!(
        s.contract.preview_withdraw(&s.user, &s.integrator, &600),
        expected
    );
    let before = s.token.balance(&s.user);
    assert_eq!(s.contract.withdraw(&s.user, &s.integrator, &600), expected);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.contract.address),
        [Withdrawn {
            user: s.user.clone(),
            integrator: s.integrator.clone(),
            amount: 600,
            loktin_fee: 6,
            integrator_fee: 6,
            to_user: 588,
        }
        .to_xdr(&s.env, &s.contract.address)]
    );
    assert_eq!(s.token.balance(&s.user) - before, 588);
    let e = s.contract.enrollment(&s.user, &s.integrator);
    assert_eq!(e.principal, 400);
    assert_eq!(e.shares, 400);
    assert_accrued(&s, &s.fee_recipient, 6, 6);
}

#[test]
fn window_first_and_last_second() {
    let s = funded();
    s.set_time(START - 1);
    assert_eq!(
        s.contract.try_withdraw(&s.user, &s.integrator, &1),
        Err(Ok(Error::OutsideWindow))
    );
    s.set_time(START);
    s.contract.withdraw(&s.user, &s.integrator, &1);
    s.set_time(START + DAY - 1);
    s.contract.withdraw(&s.user, &s.integrator, &1);
    s.set_time(START + DAY);
    assert_eq!(
        s.contract.try_withdraw(&s.user, &s.integrator, &1),
        Err(Ok(Error::OutsideWindow))
    );
}

#[test]
fn amount_bounds() {
    let s = funded();
    for amount in [0, -1] {
        assert_eq!(
            s.contract.try_withdraw(&s.user, &s.integrator, &amount),
            Err(Ok(Error::InvalidAmount))
        );
        assert_eq!(
            s.contract
                .try_preview_withdraw(&s.user, &s.integrator, &amount),
            Err(Ok(Error::InvalidAmount))
        );
    }
    assert_eq!(
        s.contract.try_withdraw(&s.user, &s.integrator, &1_001),
        Err(Ok(Error::ExceedsBalance))
    );
    assert_eq!(
        s.contract
            .try_preview_withdraw(&s.user, &s.integrator, &1_001),
        Err(Ok(Error::ExceedsBalance))
    );
    // One unit, then everything that is left.
    s.contract.withdraw(&s.user, &s.integrator, &1);
    s.contract.withdraw(&s.user, &s.integrator, &999);
    assert_eq!(s.principal(), 0);
    // 1% of 1 rounds down to 0; 1% of 999 is 9 each.
    assert_accrued(&s, &s.fee_recipient, 9, 9);
}

#[test]
fn withdraw_rounding_favours_the_user_and_skips_zero_transfers() {
    let s = funded();
    // 1% of 99 rounds down to 0, so only the user is paid.
    let w = s.contract.withdraw(&s.user, &s.integrator, &99);
    assert_eq!(w.loktin_fee, 0);
    assert_eq!(w.integrator_fee, 0);
    assert_eq!(w.to_user, 99);
    // `withdrawn` and one token transfer.
    assert_eq!(s.env.events().all().events().len(), 2);
    assert_accrued(&s, &s.fee_recipient, 0, 0);
}

#[test]
fn loktin_fee_accrues_to_the_current_recipient() {
    let s = funded();
    let recipient = Address::generate(&s.env);
    s.contract.set_fee_recipient(&recipient, &s.fee_admin);
    s.contract.withdraw(&s.user, &s.integrator, &1_000);
    assert_accrued(&s, &recipient, 10, 10);
    assert_eq!(s.contract.accrued_fees(&s.fee_recipient), 0);
    assert_eq!(s.token.balance(&s.fee_recipient), 0);
}

#[test]
fn withdraw_rejects_unknown_enrolment() {
    let s = funded();
    let stranger = Address::generate(&s.env);
    assert_eq!(
        s.contract.try_withdraw(&stranger, &s.integrator, &1),
        Err(Ok(Error::EnrollmentNotFound))
    );
    assert_eq!(
        s.contract
            .try_preview_withdraw(&stranger, &s.integrator, &1),
        Err(Ok(Error::EnrollmentNotFound))
    );
}
