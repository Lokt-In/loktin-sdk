mod common;

use common::{percent, TODAY};
use loktin_spend_save::{Destination, EnrollmentClosed, Error, MAX_ENROLLMENTS};
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{Address, Event as _};

#[test]
fn closes_an_empty_enrolment_and_emits_event() {
    let s = common::setup();
    s.enroll_default();
    s.contract.close(&s.user, &s.integrator);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.contract.address),
        [EnrollmentClosed {
            user: s.user.clone(),
            integrator: s.integrator.clone(),
        }
        .to_xdr(&s.env, &s.contract.address)]
    );
    assert_eq!(
        s.contract.try_enrollment(&s.user, &s.integrator),
        Err(Ok(Error::EnrollmentNotFound))
    );
    // The user can enrol with the same integrator again.
    s.enroll_default();
}

#[test]
fn close_refuses_a_balance() {
    let s = common::setup();
    s.mint(&s.user, 1_000);
    s.enroll_default();
    s.contract.save_for_spend(&s.user, &s.integrator, &10);
    assert_eq!(
        s.contract.try_close(&s.user, &s.integrator),
        Err(Ok(Error::BalanceNotZero))
    );
    s.contract.withdraw(&s.user, &s.integrator, &1);
    s.contract.close(&s.user, &s.integrator);
}

#[test]
fn closing_frees_a_slot() {
    let s = common::setup();
    let mut integrators = std::vec::Vec::new();
    for _ in 0..MAX_ENROLLMENTS {
        let integrator = Address::generate(&s.env);
        s.contract.enroll(
            &s.user,
            &integrator,
            &0,
            &percent(100),
            &None,
            &Destination::Balance,
            &TODAY,
        );
        integrators.push(integrator);
    }
    s.contract.close(&s.user, &integrators[2]);
    let another = Address::generate(&s.env);
    s.contract.enroll(
        &s.user,
        &another,
        &0,
        &percent(100),
        &None,
        &Destination::Balance,
        &TODAY,
    );
    // The others are untouched.
    for (index, integrator) in integrators.iter().enumerate() {
        assert_eq!(
            s.contract.try_enrollment(&s.user, integrator).is_ok(),
            index != 2
        );
    }
}

#[test]
fn close_rejects_unknown_enrolment() {
    let s = common::setup();
    assert_eq!(
        s.contract.try_close(&s.user, &s.integrator),
        Err(Ok(Error::EnrollmentNotFound))
    );
}
