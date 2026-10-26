//! Accrued fees (W63): withdrawals credit the integrator and the fee
//! recipient, and each claims its own fees with `claim_fees`.

mod common;

use common::{Setup, START, WEEK};
use loktin_target_savings::{DataKey, Error, FeesClaimed, WithdrawalRule};
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{Address, Event as _};

/// An instance charging 1%, with every auth mocked.
fn setup<'a>() -> Setup<'a> {
    let s = common::setup_with_fee(100);
    s.env.mock_all_auths();
    s
}

/// Creates a goal of 10,000 through an integrator charging 1%, deposits
/// `principal` and withdraws it early with a 10% penalty. Returns what
/// accrued to the integrator and to the fee recipient.
fn withdraw_early(s: &Setup, principal: i128) -> (i128, i128) {
    s.mint(&s.owner, principal);
    let id = s.contract.create_goal(
        &s.owner,
        &10_000,
        &(START + 10 * WEEK),
        &WEEK,
        &1_000,
        &WithdrawalRule::Penalty(1_000),
        &s.integrator,
        &100,
        &None,
    );
    s.contract.deposit(&s.owner, &id, &principal);
    let w = s.contract.withdraw(&s.owner, &id);
    (w.penalty + w.integrator_fee, w.loktin_fee)
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
    assert_eq!(withdraw_early(&s, 5_000), (550, 50));
    assert!(has_entry(&s, &s.integrator));

    assert_eq!(s.contract.claim_fees(&s.integrator), 550);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.contract.address),
        [FeesClaimed {
            recipient: s.integrator.clone(),
            amount: 550,
        }
        .to_xdr(&s.env, &s.contract.address)]
    );
    assert_eq!(s.token.balance(&s.integrator), 550);
    assert_eq!(s.contract.accrued_fees(&s.integrator), 0);
    assert!(!has_entry(&s, &s.integrator));
    // The fee recipient's share is untouched until it claims.
    assert_eq!(s.contract.accrued_fees(&s.fee_recipient), 50);
    assert_eq!(s.token.balance(&s.contract.address), 50);

    assert_eq!(s.contract.claim_fees(&s.fee_recipient), 50);
    assert_eq!(s.token.balance(&s.fee_recipient), 50);
    assert_eq!(s.token.balance(&s.contract.address), 0);
}

#[test]
fn a_second_claim_has_nothing_to_claim() {
    let s = setup();
    withdraw_early(&s, 5_000);
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
    assert_eq!(s.token.balance(&s.integrator), 550);
}

#[test]
fn zero_fees_create_no_entry() {
    let s = setup();
    // 1% of 99 rounds down to 0, and the penalty is 9.
    assert_eq!(withdraw_early(&s, 99), (9, 0));
    assert!(!has_entry(&s, &s.fee_recipient));
    assert_eq!(
        s.contract.try_claim_fees(&s.fee_recipient),
        Err(Ok(Error::NothingToClaim))
    );
}

#[test]
fn fees_from_several_goals_and_withdrawals_add_up() {
    let s = setup();
    let first = withdraw_early(&s, 5_000);
    let second = withdraw_early(&s, 2_000);
    let third = withdraw_early(&s, 999);
    let to_integrator = first.0 + second.0 + third.0;
    let loktin = first.1 + second.1 + third.1;
    assert_eq!((to_integrator, loktin), (550 + 220 + 108, 50 + 20 + 9));
    assert_eq!(s.contract.accrued_fees(&s.integrator), to_integrator);
    assert_eq!(s.contract.accrued_fees(&s.fee_recipient), loktin);
    assert_eq!(s.contract.claim_fees(&s.integrator), to_integrator);
    assert_eq!(s.contract.claim_fees(&s.fee_recipient), loktin);
    assert_eq!(s.token.balance(&s.contract.address), 0);
}

#[test]
fn claim_works_while_paused() {
    let s = setup();
    withdraw_early(&s, 5_000);
    s.contract.pause(&s.pauser);
    assert_eq!(s.contract.claim_fees(&s.integrator), 550);
    assert_eq!(s.token.balance(&s.integrator), 550);
}
