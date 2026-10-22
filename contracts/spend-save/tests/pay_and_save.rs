mod common;

use common::round_up;
use loktin_spend_save::{Destination, Error, Paid, Saved, Saving, SkimSettings};
use soroban_sdk::testutils::{Address as _, Events as _, MuxedAddress as _};
use soroban_sdk::{Address, Event as _, MuxedAddress};

fn saving(skim: i128, cap_trimmed: i128, shortfall: i128, to_balance: i128) -> Saving {
    Saving {
        skim,
        cap_trimmed,
        shortfall,
        to_balance,
        to_goal: 0,
        goal_id: None,
    }
}

#[test]
fn pays_the_payee_and_saves_the_skim() {
    let s = common::setup();
    s.mint(&s.user, 2_000);
    s.enroll_default();
    let to = MuxedAddress::from(&s.payee);
    let result = s.contract.pay_and_save(&s.user, &s.integrator, &to, &1_000);
    assert_eq!(result, saving(100, 0, 0, 100));
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.contract.address),
        [
            Paid {
                user: s.user.clone(),
                integrator: s.integrator.clone(),
                to: to.clone(),
                amount: 1_000,
            }
            .to_xdr(&s.env, &s.contract.address),
            Saved {
                user: s.user.clone(),
                integrator: s.integrator.clone(),
                spent: 1_000,
                skim: 100,
                cap_trimmed: 0,
                shortfall: 0,
                to_balance: 100,
                to_goal: 0,
                goal_id: None,
            }
            .to_xdr(&s.env, &s.contract.address),
        ]
    );
    assert_eq!(s.token.balance(&s.payee), 1_000);
    assert_eq!(s.token.balance(&s.user), 900);
    assert_eq!(s.token.balance(&s.contract.address), 100);
    let e = s.contract.enrollment(&s.user, &s.integrator);
    assert_eq!(e.principal, 100);
    assert_eq!(e.shares, 100);
    assert_eq!(e.saved_this_month, 100);
    assert_eq!(e.total_spent, 1_000);
    assert_eq!(e.total_saved, 100);
}

#[test]
fn pays_a_muxed_address() {
    let s = common::setup();
    s.mint(&s.user, 2_000);
    s.enroll_default();
    // A muxed address is always a classic account. The issuer of a second
    // test asset is an account that exists; it gets a trustline for ours.
    let account = s
        .env
        .register_stellar_asset_contract_v2(Address::generate(&s.env))
        .issuer()
        .address();
    s.asset.trust(&account);
    let to = MuxedAddress::new(account, 42);
    s.contract.pay_and_save(&s.user, &s.integrator, &to, &1_000);
    assert_eq!(to.id(), Some(42));
    assert_eq!(s.token.balance(&to.address()), 1_000);
    assert_eq!(s.principal(), 100);
}

#[test]
fn exact_multiple_rounds_up_by_nothing() {
    let s = common::setup();
    s.mint(&s.user, 10_000);
    s.enroll(round_up(100), None, Destination::Balance, 1);
    let to = MuxedAddress::from(&s.payee);
    assert_eq!(
        s.contract.pay_and_save(&s.user, &s.integrator, &to, &300),
        saving(0, 0, 0, 0)
    );
    assert_eq!(
        s.contract.pay_and_save(&s.user, &s.integrator, &to, &301),
        saving(99, 0, 0, 99)
    );
    assert_eq!(s.principal(), 99);
}

#[test]
fn percentage_and_round_up_add_together() {
    let s = common::setup();
    s.mint(&s.user, 10_000);
    let skim = SkimSettings {
        percent_bps: Some(1_000),
        round_up_unit: Some(100),
    };
    s.enroll(skim, None, Destination::Balance, 1);
    let to = MuxedAddress::from(&s.payee);
    // 10% of 250 is 25, and 250 rounds up to 300 for another 50.
    assert_eq!(
        s.contract.pay_and_save(&s.user, &s.integrator, &to, &250),
        saving(75, 0, 0, 75)
    );
}

#[test]
fn payment_that_leaves_nothing_saves_nothing_and_still_succeeds() {
    let s = common::setup();
    s.mint(&s.user, 1_000);
    s.enroll_default();
    let to = MuxedAddress::from(&s.payee);
    let result = s.contract.pay_and_save(&s.user, &s.integrator, &to, &1_000);
    assert_eq!(result, saving(100, 0, 100, 0));
    // `saved` is still emitted, with the shortfall.
    let events = s.env.events().all().filter_by_contract(&s.contract.address);
    assert_eq!(events.events().len(), 2);
    assert_eq!(s.token.balance(&s.payee), 1_000);
    assert_eq!(s.token.balance(&s.user), 0);
    assert_eq!(s.principal(), 0);
}

#[test]
fn skim_shrinks_to_what_the_wallet_can_cover() {
    let s = common::setup();
    s.mint(&s.user, 1_040);
    s.enroll_default();
    let to = MuxedAddress::from(&s.payee);
    assert_eq!(
        s.contract.pay_and_save(&s.user, &s.integrator, &to, &1_000),
        saving(100, 0, 60, 40)
    );
    assert_eq!(s.token.balance(&s.user), 0);
}

#[test]
fn paying_oneself_leaves_the_whole_balance_for_the_skim() {
    let s = common::setup();
    s.mint(&s.user, 1_000);
    s.enroll_default();
    let to = MuxedAddress::from(&s.user);
    assert_eq!(
        s.contract.pay_and_save(&s.user, &s.integrator, &to, &1_000),
        saving(100, 0, 0, 100)
    );
    assert_eq!(s.token.balance(&s.user), 900);
}

#[test]
fn rejects_payment_above_the_balance() {
    let s = common::setup();
    s.mint(&s.user, 999);
    s.enroll_default();
    let to = MuxedAddress::from(&s.payee);
    assert_eq!(
        s.contract
            .try_pay_and_save(&s.user, &s.integrator, &to, &1_000),
        Err(Ok(Error::PaymentShortfall))
    );
}

#[test]
fn pay_and_save_rejects_amounts_not_above_zero() {
    let s = common::setup();
    s.mint(&s.user, 1_000);
    s.enroll_default();
    let to = MuxedAddress::from(&s.payee);
    for amount in [0, -1] {
        assert_eq!(
            s.contract
                .try_pay_and_save(&s.user, &s.integrator, &to, &amount),
            Err(Ok(Error::InvalidAmount))
        );
    }
}

#[test]
fn rejects_this_contract_as_payee() {
    let s = common::setup();
    s.mint(&s.user, 1_000);
    s.enroll_default();
    let to = MuxedAddress::from(&s.contract.address);
    assert_eq!(
        s.contract
            .try_pay_and_save(&s.user, &s.integrator, &to, &10),
        Err(Ok(Error::InvalidPayee))
    );
}

#[test]
fn pay_and_save_rejects_unknown_enrolment() {
    let s = common::setup();
    s.mint(&s.user, 1_000);
    let to = MuxedAddress::from(&s.payee);
    let stranger = Address::generate(&s.env);
    assert_eq!(
        s.contract.try_pay_and_save(&s.user, &stranger, &to, &10),
        Err(Ok(Error::EnrollmentNotFound))
    );
}
