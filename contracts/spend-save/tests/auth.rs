//! T2: exactly who authorizes each user and role function, and that a
//! stranger is refused. No blanket auth mocking in this file.

mod common;

use common::{percent, Setup, START, TODAY, WEEK};
use loktin_common::roles;
use loktin_spend_save::{Destination, Error};
use loktin_target_savings::WithdrawalRule;
use soroban_sdk::testutils::{
    Address as _, AuthorizedFunction, AuthorizedInvocation, MockAuth, MockAuthInvoke,
};
use soroban_sdk::xdr::{ScErrorCode, ScErrorType};
use soroban_sdk::{Address, IntoVal, InvokeError, MuxedAddress, Symbol, Val, Vec};

const UNAUTHORIZED: u32 = 2000;

fn invocation(
    contract: &Address,
    function: &str,
    args: Vec<Val>,
    sub_invocations: std::vec::Vec<AuthorizedInvocation>,
) -> AuthorizedInvocation {
    AuthorizedInvocation {
        function: AuthorizedFunction::Contract((
            contract.clone(),
            Symbol::new(contract.env(), function),
            args,
        )),
        sub_invocations,
    }
}

/// Signs one call to the Spend & Save contract, with no sub-invocations.
fn sign(s: &Setup, address: &Address, function: &str, args: Vec<Val>) {
    s.env.mock_auths(&[MockAuth {
        address,
        invoke: &MockAuthInvoke {
            contract: &s.contract.address,
            fn_name: function,
            args,
            sub_invokes: &[],
        },
    }]);
}

fn enroll_args(s: &Setup, user: &Address, destination: Destination) -> Vec<Val> {
    (
        user.clone(),
        s.integrator.clone(),
        0_u32,
        percent(1_000),
        None::<i128>,
        destination,
        TODAY,
    )
        .into_val(&s.env)
}

fn enroll_signed(s: &Setup, destination: Destination) {
    sign(s, &s.user, "enroll", enroll_args(s, &s.user, destination));
    s.contract.enroll(
        &s.user,
        &s.integrator,
        &0,
        &percent(1_000),
        &None,
        &destination,
        &TODAY,
    );
}

fn mint(s: &Setup, to: &Address, amount: i128) {
    s.env.mock_auths(&[MockAuth {
        address: &s.issuer,
        invoke: &MockAuthInvoke {
            contract: &s.token.address,
            fn_name: "mint",
            args: (to, amount).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    s.asset.mint(to, &amount);
}

/// Saves 1,000 into the balance with a signed `save_for_spend`.
fn save_signed(s: &Setup) {
    s.env.mock_auths(&[MockAuth {
        address: &s.user,
        invoke: &MockAuthInvoke {
            contract: &s.contract.address,
            fn_name: "save_for_spend",
            args: (&s.user, &s.integrator, 10_000_i128).into_val(&s.env),
            sub_invokes: &[MockAuthInvoke {
                contract: &s.token.address,
                fn_name: "transfer",
                args: (&s.user, &s.contract.address, 1_000_i128).into_val(&s.env),
                sub_invokes: &[],
            }],
        },
    }]);
    s.contract.save_for_spend(&s.user, &s.integrator, &10_000);
}

fn refused_auth<T, E>(result: Result<T, Result<E, InvokeError>>) -> bool {
    matches!(result, Err(Err(InvokeError::Abort)))
}

fn context_error() -> soroban_sdk::Error {
    soroban_sdk::Error::from_type_and_code(ScErrorType::Context, ScErrorCode::InvalidAction)
}

#[test]
fn enroll_is_authorized_by_the_user() {
    let s = common::setup_with_fee(0);
    enroll_signed(&s, Destination::Balance);
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.user.clone(),
            invocation(
                &s.contract.address,
                "enroll",
                enroll_args(&s, &s.user, Destination::Balance),
                std::vec![],
            )
        )]
    );
}

#[test]
fn enroll_for_someone_else_is_refused() {
    let s = common::setup_with_fee(0);
    let stranger = Address::generate(&s.env);
    sign(
        &s,
        &stranger,
        "enroll",
        enroll_args(&s, &s.user, Destination::Balance),
    );
    assert!(refused_auth(s.contract.try_enroll(
        &s.user,
        &s.integrator,
        &0,
        &percent(1_000),
        &None,
        &Destination::Balance,
        &TODAY,
    )));
}

#[test]
fn update_settings_is_authorized_by_the_user_and_refused_to_others() {
    let s = common::setup_with_fee(0);
    enroll_signed(&s, Destination::Balance);
    let args: Vec<Val> = (
        s.user.clone(),
        s.integrator.clone(),
        percent(200),
        None::<i128>,
        Destination::Balance,
        TODAY,
    )
        .into_val(&s.env);
    sign(&s, &s.user, "update_settings", args.clone());
    s.contract.update_settings(
        &s.user,
        &s.integrator,
        &percent(200),
        &None,
        &Destination::Balance,
        &TODAY,
    );
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.user.clone(),
            invocation(
                &s.contract.address,
                "update_settings",
                args.clone(),
                std::vec![]
            )
        )]
    );
    let stranger = Address::generate(&s.env);
    sign(&s, &stranger, "update_settings", args);
    assert!(refused_auth(s.contract.try_update_settings(
        &s.user,
        &s.integrator,
        &percent(200),
        &None,
        &Destination::Balance,
        &TODAY,
    )));
}

#[test]
fn save_for_spend_is_authorized_by_the_user_including_the_transfer() {
    let s = common::setup_with_fee(0);
    mint(&s, &s.user, 5_000);
    enroll_signed(&s, Destination::Balance);
    save_signed(&s);
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.user.clone(),
            invocation(
                &s.contract.address,
                "save_for_spend",
                (&s.user, &s.integrator, 10_000_i128).into_val(&s.env),
                std::vec![invocation(
                    &s.token.address,
                    "transfer",
                    (&s.user, &s.contract.address, 1_000_i128).into_val(&s.env),
                    std::vec![],
                )],
            )
        )]
    );
}

#[test]
fn save_for_spend_by_a_stranger_is_refused() {
    let s = common::setup_with_fee(0);
    mint(&s, &s.user, 5_000);
    enroll_signed(&s, Destination::Balance);
    let stranger = Address::generate(&s.env);
    sign(
        &s,
        &stranger,
        "save_for_spend",
        (&s.user, &s.integrator, 10_i128).into_val(&s.env),
    );
    assert!(refused_auth(s.contract.try_save_for_spend(
        &s.user,
        &s.integrator,
        &10
    )));
}

#[test]
fn pay_and_save_is_authorized_by_the_user_including_both_transfers() {
    let s = common::setup_with_fee(0);
    mint(&s, &s.user, 5_000);
    enroll_signed(&s, Destination::Balance);
    let to = MuxedAddress::from(&s.payee);
    let args: Vec<Val> = (&s.user, &s.integrator, &to, 1_000_i128).into_val(&s.env);
    let payment: Vec<Val> = (&s.user, &to, 1_000_i128).into_val(&s.env);
    let skim: Vec<Val> = (&s.user, &s.contract.address, 100_i128).into_val(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &s.user,
        invoke: &MockAuthInvoke {
            contract: &s.contract.address,
            fn_name: "pay_and_save",
            args: args.clone(),
            sub_invokes: &[
                MockAuthInvoke {
                    contract: &s.token.address,
                    fn_name: "transfer",
                    args: payment.clone(),
                    sub_invokes: &[],
                },
                MockAuthInvoke {
                    contract: &s.token.address,
                    fn_name: "transfer",
                    args: skim.clone(),
                    sub_invokes: &[],
                },
            ],
        },
    }]);
    s.contract.pay_and_save(&s.user, &s.integrator, &to, &1_000);
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.user.clone(),
            invocation(
                &s.contract.address,
                "pay_and_save",
                args,
                std::vec![
                    invocation(&s.token.address, "transfer", payment, std::vec![]),
                    invocation(&s.token.address, "transfer", skim, std::vec![]),
                ],
            )
        )]
    );
}

#[test]
fn pay_and_save_into_a_goal_is_one_user_signature() {
    let s = common::setup_with_fee(0);
    mint(&s, &s.user, 5_000);
    // A goal created under the user's own signature.
    s.env.mock_auths(&[MockAuth {
        address: &s.user,
        invoke: &MockAuthInvoke {
            contract: &s.savings.address,
            fn_name: "create_goal",
            args: (
                s.user.clone(),
                5_000_i128,
                START + 10 * WEEK,
                WEEK,
                1_i128,
                WithdrawalRule::Lock,
                s.integrator.clone(),
                0_u32,
                None::<(i128, u32)>,
            )
                .into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    let goal = s.create_goal(5_000);
    enroll_signed(&s, Destination::Goal(goal));
    let to = MuxedAddress::from(&s.payee);
    let args: Vec<Val> = (&s.user, &s.integrator, &to, 1_000_i128).into_val(&s.env);
    let deposit: Vec<Val> = (&s.user, goal, 100_i128).into_val(&s.env);
    let into_goal: Vec<Val> = (&s.user, &s.savings.address, 100_i128).into_val(&s.env);
    let payment: Vec<Val> = (&s.user, &to, 1_000_i128).into_val(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &s.user,
        invoke: &MockAuthInvoke {
            contract: &s.contract.address,
            fn_name: "pay_and_save",
            args: args.clone(),
            sub_invokes: &[
                MockAuthInvoke {
                    contract: &s.savings.address,
                    fn_name: "deposit",
                    args: deposit.clone(),
                    sub_invokes: &[MockAuthInvoke {
                        contract: &s.token.address,
                        fn_name: "transfer",
                        args: into_goal.clone(),
                        sub_invokes: &[],
                    }],
                },
                MockAuthInvoke {
                    contract: &s.token.address,
                    fn_name: "transfer",
                    args: payment.clone(),
                    sub_invokes: &[],
                },
            ],
        },
    }]);
    assert_eq!(
        s.contract
            .pay_and_save(&s.user, &s.integrator, &to, &1_000)
            .to_goal,
        100
    );
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.user.clone(),
            invocation(
                &s.contract.address,
                "pay_and_save",
                args,
                std::vec![
                    invocation(
                        &s.savings.address,
                        "deposit",
                        deposit,
                        std::vec![invocation(
                            &s.token.address,
                            "transfer",
                            into_goal,
                            std::vec![],
                        )],
                    ),
                    invocation(&s.token.address, "transfer", payment, std::vec![]),
                ],
            )
        )]
    );
}

#[test]
fn pay_and_save_by_a_stranger_is_refused() {
    let s = common::setup_with_fee(0);
    mint(&s, &s.user, 5_000);
    enroll_signed(&s, Destination::Balance);
    let stranger = Address::generate(&s.env);
    let to = MuxedAddress::from(&stranger);
    sign(
        &s,
        &stranger,
        "pay_and_save",
        (&s.user, &s.integrator, &to, 1_000_i128).into_val(&s.env),
    );
    assert!(refused_auth(s.contract.try_pay_and_save(
        &s.user,
        &s.integrator,
        &to,
        &1_000
    )));
    assert_eq!(s.token.balance(&stranger), 0);
}

#[test]
fn withdraw_and_close_are_authorized_by_the_user_only() {
    let s = common::setup_with_fee(0);
    mint(&s, &s.user, 5_000);
    enroll_signed(&s, Destination::Balance);
    save_signed(&s);
    let args: Vec<Val> = (&s.user, &s.integrator, 1_000_i128).into_val(&s.env);
    sign(&s, &s.user, "withdraw", args.clone());
    s.contract.withdraw(&s.user, &s.integrator, &1_000);
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.user.clone(),
            invocation(&s.contract.address, "withdraw", args, std::vec![])
        )]
    );
    let args: Vec<Val> = (&s.user, &s.integrator).into_val(&s.env);
    sign(&s, &s.user, "close", args.clone());
    s.contract.close(&s.user, &s.integrator);
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.user.clone(),
            invocation(&s.contract.address, "close", args, std::vec![])
        )]
    );
}

#[test]
fn withdraw_and_close_by_a_stranger_are_refused() {
    let s = common::setup_with_fee(0);
    mint(&s, &s.user, 5_000);
    enroll_signed(&s, Destination::Balance);
    save_signed(&s);
    let stranger = Address::generate(&s.env);
    sign(
        &s,
        &stranger,
        "withdraw",
        (&s.user, &s.integrator, 1_000_i128).into_val(&s.env),
    );
    assert!(refused_auth(s.contract.try_withdraw(
        &s.user,
        &s.integrator,
        &1_000
    )));
    sign(
        &s,
        &stranger,
        "close",
        (&s.user, &s.integrator).into_val(&s.env),
    );
    assert!(refused_auth(s.contract.try_close(&s.user, &s.integrator)));
    // A stranger signing as themselves has no enrolment.
    sign(
        &s,
        &stranger,
        "withdraw",
        (&stranger, &s.integrator, 1_i128).into_val(&s.env),
    );
    assert_eq!(
        s.contract.try_withdraw(&stranger, &s.integrator, &1),
        Err(Ok(Error::EnrollmentNotFound))
    );
    assert_eq!(s.principal(), 1_000);
}

#[test]
fn fee_functions_are_authorized_by_the_fee_admin_only() {
    let s = common::setup_with_fee(0);
    let args: Vec<Val> = (50_u32, &s.fee_admin).into_val(&s.env);
    sign(&s, &s.fee_admin, "set_loktin_fee", args.clone());
    s.contract.set_loktin_fee(&50, &s.fee_admin);
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.fee_admin.clone(),
            invocation(&s.contract.address, "set_loktin_fee", args, std::vec![])
        )]
    );
    let recipient = Address::generate(&s.env);
    let args: Vec<Val> = (&recipient, &s.fee_admin).into_val(&s.env);
    sign(&s, &s.fee_admin, "set_fee_recipient", args.clone());
    s.contract.set_fee_recipient(&recipient, &s.fee_admin);
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.fee_admin.clone(),
            invocation(&s.contract.address, "set_fee_recipient", args, std::vec![])
        )]
    );
    let stranger = Address::generate(&s.env);
    for caller in [&stranger, &s.admin, &s.pauser, &s.upgrader] {
        sign(
            &s,
            caller,
            "set_loktin_fee",
            (1_u32, caller).into_val(&s.env),
        );
        assert_eq!(
            s.contract.try_set_loktin_fee(&1, caller),
            Err(Err(InvokeError::Contract(UNAUTHORIZED)))
        );
        sign(
            &s,
            caller,
            "set_fee_recipient",
            (&stranger, caller).into_val(&s.env),
        );
        assert_eq!(
            s.contract.try_set_fee_recipient(&stranger, caller),
            Err(Err(InvokeError::Contract(UNAUTHORIZED)))
        );
    }
    s.env.mock_auths(&[]);
    assert!(refused_auth(
        s.contract.try_set_loktin_fee(&1, &s.fee_admin)
    ));
    assert_eq!(s.contract.loktin_fee_bps(), 50);
}

#[test]
fn pause_and_unpause_are_authorized_by_the_pauser_only() {
    let s = common::setup_with_fee(0);
    let args: Vec<Val> = (&s.pauser,).into_val(&s.env);
    sign(&s, &s.pauser, "pause", args.clone());
    s.contract.pause(&s.pauser);
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.pauser.clone(),
            invocation(&s.contract.address, "pause", args.clone(), std::vec![])
        )]
    );
    let stranger = Address::generate(&s.env);
    for caller in [&stranger, &s.admin, &s.fee_admin, &s.upgrader] {
        sign(&s, caller, "unpause", (caller,).into_val(&s.env));
        assert_eq!(
            s.contract.try_unpause(caller),
            Err(Ok(soroban_sdk::Error::from_contract_error(UNAUTHORIZED)))
        );
    }
    s.env.mock_auths(&[]);
    assert_eq!(s.contract.try_unpause(&s.pauser), Err(Ok(context_error())));
    sign(&s, &s.pauser, "unpause", args.clone());
    s.contract.unpause(&s.pauser);
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.pauser.clone(),
            invocation(&s.contract.address, "unpause", args, std::vec![])
        )]
    );
    for caller in [&stranger, &s.admin, &s.fee_admin, &s.upgrader] {
        sign(&s, caller, "pause", (caller,).into_val(&s.env));
        assert_eq!(
            s.contract.try_pause(caller),
            Err(Ok(soroban_sdk::Error::from_contract_error(UNAUTHORIZED)))
        );
    }
    assert!(!s.contract.paused());
}

#[test]
fn grant_role_is_authorized_by_the_admin_only() {
    let s = common::setup_with_fee(0);
    let account = Address::generate(&s.env);
    let args: Vec<Val> = (&account, roles::PAUSER, &s.admin).into_val(&s.env);
    sign(&s, &s.admin, "grant_role", args.clone());
    s.contract.grant_role(&account, &roles::PAUSER, &s.admin);
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.admin.clone(),
            invocation(&s.contract.address, "grant_role", args, std::vec![])
        )]
    );
    let stranger = Address::generate(&s.env);
    for caller in [&stranger, &s.fee_admin, &s.pauser, &s.upgrader] {
        sign(
            &s,
            caller,
            "grant_role",
            (&stranger, roles::UPGRADER, caller).into_val(&s.env),
        );
        assert_eq!(
            s.contract
                .try_grant_role(&stranger, &roles::UPGRADER, caller),
            Err(Ok(soroban_sdk::Error::from_contract_error(UNAUTHORIZED)))
        );
    }
}

/// Accrues 1% of a 1,000 withdrawal to the fee recipient, with every call
/// signed.
fn accrue_signed(s: &Setup) {
    mint(s, &s.user, 5_000);
    enroll_signed(s, Destination::Balance);
    save_signed(s);
    sign(
        s,
        &s.user,
        "withdraw",
        (&s.user, &s.integrator, 1_000_i128).into_val(&s.env),
    );
    s.contract.withdraw(&s.user, &s.integrator, &1_000);
    assert_eq!(s.contract.accrued_fees(&s.fee_recipient), 10);
}

#[test]
fn claim_fees_is_authorized_by_the_recipient_only() {
    let s = common::setup_with_fee(100);
    accrue_signed(&s);
    let args: Vec<Val> = (&s.fee_recipient,).into_val(&s.env);
    sign(&s, &s.fee_recipient, "claim_fees", args.clone());
    assert_eq!(s.contract.claim_fees(&s.fee_recipient), 10);
    // The payout is the contract's own transfer, so no other signature.
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.fee_recipient.clone(),
            invocation(&s.contract.address, "claim_fees", args, std::vec![])
        )]
    );
    assert_eq!(s.token.balance(&s.fee_recipient), 10);
}

#[test]
fn claim_fees_by_a_stranger_is_refused() {
    let s = common::setup_with_fee(100);
    accrue_signed(&s);
    let stranger = Address::generate(&s.env);
    sign(
        &s,
        &stranger,
        "claim_fees",
        (&s.fee_recipient,).into_val(&s.env),
    );
    assert!(refused_auth(s.contract.try_claim_fees(&s.fee_recipient)));
    assert_eq!(s.contract.accrued_fees(&s.fee_recipient), 10);
    assert_eq!(s.token.balance(&s.fee_recipient), 0);
    // A stranger claiming as themselves has nothing accrued.
    sign(&s, &stranger, "claim_fees", (&stranger,).into_val(&s.env));
    assert_eq!(
        s.contract.try_claim_fees(&stranger),
        Err(Ok(Error::NothingToClaim))
    );
}
