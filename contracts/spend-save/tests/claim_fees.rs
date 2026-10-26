//! Accrued fees (W63): withdrawals credit the integrator and the fee
//! recipient, and each claims its own fees with `claim_fees`.

mod common;

use common::{percent, Setup, TODAY};
use loktin_spend_save::{DataKey, Destination, Error, FeesClaimed};
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{Address, Event as _};

/// An instance charging 1%, with every auth mocked.
fn setup<'a>() -> Setup<'a> {
    let s = common::setup_with_fee(100);
    s.env.mock_all_auths();
    s
}

/// Enrols `user` with `integrator` at a 1% integrator fee and a 10% skim,
/// saves 10% of `spent` and withdraws all of it. Returns what accrued to the
/// integrator and to the fee recipient.
fn save_and_withdraw(s: &Setup, user: &Address, integrator: &Address, spent: i128) -> (i128, i128) {
    s.mint(user, spent);
    s.contract.enroll(
        user,
        integrator,
        &100,
        &percent(1_000),
        &None,
        &Destination::Balance,
        &TODAY,
    );
    s.contract.save_for_spend(user, integrator, &spent);
    let w = s.contract.withdraw(user, integrator, &(spent / 10));
    (w.integrator_fee, w.loktin_fee)
}

fn has_entry(s: &Setup, recipient: &Address) -> bool {
    s.env.as_contract(&s.contract.address, || {
        s.env
            .storage()
            .persistent()
            .has(&DataKey::AccruedFees(recipient.clone()))
    })
}

#[test]
fn claim_pays_the_recipient_empties_the_entry_and_emits_the_event() {
    let s = setup();
    assert_eq!(
        save_and_withdraw(&s, &s.user, &s.integrator, 10_000),
        (10, 10)
    );
    assert!(has_entry(&s, &s.integrator));

    assert_eq!(s.contract.claim_fees(&s.integrator), 10);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.contract.address),
        [FeesClaimed {
            recipient: s.integrator.clone(),
            amount: 10,
        }
        .to_xdr(&s.env, &s.contract.address)]
    );
    assert_eq!(s.token.balance(&s.integrator), 10);
    assert_eq!(s.contract.accrued_fees(&s.integrator), 0);
    assert!(!has_entry(&s, &s.integrator));
    // The fee recipient's share is untouched until it claims.
    assert_eq!(s.contract.accrued_fees(&s.fee_recipient), 10);
    assert_eq!(s.token.balance(&s.contract.address), 10);

    assert_eq!(s.contract.claim_fees(&s.fee_recipient), 10);
    assert_eq!(s.token.balance(&s.fee_recipient), 10);
    assert_eq!(s.token.balance(&s.contract.address), 0);
}

#[test]
fn a_second_claim_has_nothing_to_claim() {
    let s = setup();
    save_and_withdraw(&s, &s.user, &s.integrator, 10_000);
    s.contract.claim_fees(&s.integrator);
    assert_eq!(
        s.contract.try_claim_fees(&s.integrator),
        Err(Ok(Error::NothingToClaim))
    );
    let stranger = Address::generate(&s.env);
    assert_eq!(
        s.contract.try_claim_fees(&stranger),
        Err(Ok(Error::NothingToClaim))
    );
    assert_eq!(s.token.balance(&s.integrator), 10);
}

#[test]
fn zero_fees_create_no_entry() {
    let s = setup();
    // 1% of 99 rounds down to 0 for both fees.
    assert_eq!(save_and_withdraw(&s, &s.user, &s.integrator, 990), (0, 0));
    assert!(!has_entry(&s, &s.integrator));
    assert!(!has_entry(&s, &s.fee_recipient));
}

#[test]
fn fees_from_several_enrolments_and_withdrawals_add_up() {
    let s = setup();
    let other_user = Address::generate(&s.env);
    let other_integrator = Address::generate(&s.env);
    let a = save_and_withdraw(&s, &s.user, &s.integrator, 10_000);
    let b = save_and_withdraw(&s, &other_user, &s.integrator, 50_000);
    let c = save_and_withdraw(&s, &s.user, &other_integrator, 30_000);
    assert_eq!((a, b, c), ((10, 10), (50, 50), (30, 30)));
    assert_eq!(s.contract.accrued_fees(&s.integrator), 60);
    assert_eq!(s.contract.accrued_fees(&other_integrator), 30);
    assert_eq!(s.contract.accrued_fees(&s.fee_recipient), 90);
    assert_eq!(s.contract.claim_fees(&s.integrator), 60);
    assert_eq!(s.contract.claim_fees(&other_integrator), 30);
    assert_eq!(s.contract.claim_fees(&s.fee_recipient), 90);
    assert_eq!(s.token.balance(&s.contract.address), 0);
}

#[test]
fn claim_works_while_paused() {
    let s = setup();
    save_and_withdraw(&s, &s.user, &s.integrator, 10_000);
    s.contract.pause(&s.pauser);
    assert_eq!(s.contract.claim_fees(&s.integrator), 10);
    assert_eq!(s.token.balance(&s.integrator), 10);
}
