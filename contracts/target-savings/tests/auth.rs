//! T2: exactly who authorizes each user and role function, and that a
//! stranger is refused. No blanket auth mocking in this file.

mod common;

use common::{Setup, START, WEEK};
use loktin_common::roles;
use loktin_target_savings::{Error, WithdrawalRule};
use soroban_sdk::testutils::{
    Address as _, AuthorizedFunction, AuthorizedInvocation, MockAuth, MockAuthInvoke,
};
use soroban_sdk::xdr::{ScErrorCode, ScErrorType};
use soroban_sdk::{Address, IntoVal, InvokeError, Symbol, Val, Vec};

const UNAUTHORIZED: u32 = 2000;

fn invocation(
    s: &Setup,
    contract: &Address,
    function: &str,
    args: Vec<Val>,
    sub_invocations: std::vec::Vec<AuthorizedInvocation>,
) -> AuthorizedInvocation {
    let _ = s;
    AuthorizedInvocation {
        function: AuthorizedFunction::Contract((
            contract.clone(),
            Symbol::new(contract.env(), function),
            args,
        )),
        sub_invocations,
    }
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

fn create_args(s: &Setup, owner: &Address, allowance: Option<(i128, u32)>) -> Vec<Val> {
    (
        owner.clone(),
        10_000_i128,
        START + 10 * WEEK,
        WEEK,
        1_000_i128,
        WithdrawalRule::Lock,
        s.integrator.clone(),
        0_u32,
        allowance,
    )
        .into_val(&s.env)
}

/// Creates a goal signed by the owner, with an allowance of 10,000.
fn create_signed(s: &Setup) -> u64 {
    let allowance = s.allowance(10_000);
    let (amount, live_until) = allowance.unwrap();
    s.env.mock_auths(&[MockAuth {
        address: &s.owner,
        invoke: &MockAuthInvoke {
            contract: &s.contract.address,
            fn_name: "create_goal",
            args: create_args(s, &s.owner, allowance),
            sub_invokes: &[MockAuthInvoke {
                contract: &s.token.address,
                fn_name: "approve",
                args: (&s.owner, &s.contract.address, amount, live_until).into_val(&s.env),
                sub_invokes: &[],
            }],
        },
    }]);
    s.contract.create_goal(
        &s.owner,
        &10_000,
        &(START + 10 * WEEK),
        &WEEK,
        &1_000,
        &WithdrawalRule::Lock,
        &s.integrator,
        &0,
        &allowance,
    )
}

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

fn refused_auth<T, E>(result: Result<T, Result<E, InvokeError>>) -> bool {
    matches!(result, Err(Err(InvokeError::Abort)))
}

#[test]
fn create_goal_is_authorized_by_the_owner_including_the_approve() {
    let s = common::setup_with_fee(0);
    let allowance = s.allowance(10_000);
    let (amount, live_until) = allowance.unwrap();
    create_signed(&s);
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.owner.clone(),
            invocation(
                &s,
                &s.contract.address,
                "create_goal",
                create_args(&s, &s.owner, allowance),
                std::vec![invocation(
                    &s,
                    &s.token.address,
                    "approve",
                    (&s.owner, &s.contract.address, amount, live_until).into_val(&s.env),
                    std::vec![],
                )],
            )
        )]
    );
}

#[test]
fn create_goal_for_someone_else_is_refused() {
    let s = common::setup_with_fee(0);
    let stranger = Address::generate(&s.env);
    sign(
        &s,
        &stranger,
        "create_goal",
        create_args(&s, &s.owner, None),
    );
    assert!(refused_auth(s.contract.try_create_goal(
        &s.owner,
        &10_000,
        &(START + 10 * WEEK),
        &WEEK,
        &1_000,
        &WithdrawalRule::Lock,
        &s.integrator,
        &0,
        &None,
    )));
    assert_eq!(s.contract.user_goals(&s.owner).len(), 0);
    assert_eq!(s.goals_created(&s.owner), 0);
}

#[test]
fn deposit_is_authorized_by_the_owner_including_the_transfer() {
    let s = common::setup_with_fee(0);
    mint(&s, &s.owner, 1_000);
    let id = create_signed(&s);
    s.env.mock_auths(&[MockAuth {
        address: &s.owner,
        invoke: &MockAuthInvoke {
            contract: &s.contract.address,
            fn_name: "deposit",
            args: (&s.owner, id, 500_i128).into_val(&s.env),
            sub_invokes: &[MockAuthInvoke {
                contract: &s.token.address,
                fn_name: "transfer",
                args: (&s.owner, &s.contract.address, 500_i128).into_val(&s.env),
                sub_invokes: &[],
            }],
        },
    }]);
    s.contract.deposit(&s.owner, &id, &500);
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.owner.clone(),
            invocation(
                &s,
                &s.contract.address,
                "deposit",
                (&s.owner, id, 500_i128).into_val(&s.env),
                std::vec![invocation(
                    &s,
                    &s.token.address,
                    "transfer",
                    (&s.owner, &s.contract.address, 500_i128).into_val(&s.env),
                    std::vec![],
                )],
            )
        )]
    );
}

#[test]
fn deposit_by_a_stranger_is_refused() {
    let s = common::setup_with_fee(0);
    let id = create_signed(&s);
    let stranger = Address::generate(&s.env);
    // Signing for the owner fails authorization.
    sign(
        &s,
        &stranger,
        "deposit",
        (&s.owner, id, 1_i128).into_val(&s.env),
    );
    assert!(refused_auth(s.contract.try_deposit(&s.owner, &id, &1)));
    // Signing as themselves fails the ownership check.
    sign(
        &s,
        &stranger,
        "deposit",
        (&stranger, id, 1_i128).into_val(&s.env),
    );
    assert_eq!(
        s.contract.try_deposit(&stranger, &id, &1),
        Err(Ok(Error::NotOwner))
    );
}

#[test]
fn collect_needs_no_authorization_from_anyone() {
    let s = common::setup_with_fee(0);
    mint(&s, &s.owner, 1_000);
    let id = create_signed(&s);
    s.set_time(START + WEEK);
    s.env.mock_auths(&[]);
    s.contract.collect(&id);
    assert_eq!(s.env.auths(), std::vec![]);
    assert_eq!(s.contract.goal(&id).principal, 1_000);
}

#[test]
fn withdraw_is_authorized_by_the_owner_only() {
    let s = common::setup_with_fee(0);
    let id = create_signed(&s);
    sign(&s, &s.owner, "withdraw", (&s.owner, id).into_val(&s.env));
    s.contract.withdraw(&s.owner, &id);
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.owner.clone(),
            invocation(
                &s,
                &s.contract.address,
                "withdraw",
                (&s.owner, id).into_val(&s.env),
                std::vec![],
            )
        )]
    );
}

#[test]
fn withdraw_by_a_stranger_is_refused() {
    let s = common::setup_with_fee(0);
    let id = create_signed(&s);
    let stranger = Address::generate(&s.env);
    sign(&s, &stranger, "withdraw", (&s.owner, id).into_val(&s.env));
    assert!(refused_auth(s.contract.try_withdraw(&s.owner, &id)));
    sign(&s, &stranger, "withdraw", (&stranger, id).into_val(&s.env));
    assert_eq!(
        s.contract.try_withdraw(&stranger, &id),
        Err(Ok(Error::NotOwner))
    );
    assert_eq!(s.contract.goal(&id).id, id);
}

#[test]
fn set_loktin_fee_is_authorized_by_the_fee_admin() {
    let s = common::setup_with_fee(0);
    let args: Vec<Val> = (50_u32, &s.fee_admin).into_val(&s.env);
    sign(&s, &s.fee_admin, "set_loktin_fee", args.clone());
    s.contract.set_loktin_fee(&50, &s.fee_admin);
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.fee_admin.clone(),
            invocation(&s, &s.contract.address, "set_loktin_fee", args, std::vec![])
        )]
    );
}

#[test]
fn set_fee_recipient_is_authorized_by_the_fee_admin() {
    let s = common::setup_with_fee(0);
    let recipient = Address::generate(&s.env);
    let args: Vec<Val> = (&recipient, &s.fee_admin).into_val(&s.env);
    sign(&s, &s.fee_admin, "set_fee_recipient", args.clone());
    s.contract.set_fee_recipient(&recipient, &s.fee_admin);
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.fee_admin.clone(),
            invocation(
                &s,
                &s.contract.address,
                "set_fee_recipient",
                args,
                std::vec![]
            )
        )]
    );
}

#[test]
fn fee_functions_refuse_everyone_but_the_fee_admin() {
    let s = common::setup_with_fee(0);
    let stranger = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);
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
            (&recipient, caller).into_val(&s.env),
        );
        assert_eq!(
            s.contract.try_set_fee_recipient(&recipient, caller),
            Err(Err(InvokeError::Contract(UNAUTHORIZED)))
        );
    }
    // The fee admin's address without its signature is refused too.
    s.env.mock_auths(&[]);
    assert!(refused_auth(
        s.contract.try_set_loktin_fee(&1, &s.fee_admin)
    ));
    assert_eq!(s.contract.loktin_fee_bps(), 0);
}

#[test]
fn pause_and_unpause_are_authorized_by_the_pauser() {
    let s = common::setup_with_fee(0);
    for function in ["pause", "unpause"] {
        let args: Vec<Val> = (&s.pauser,).into_val(&s.env);
        sign(&s, &s.pauser, function, args.clone());
        if function == "pause" {
            s.contract.pause(&s.pauser);
        } else {
            s.contract.unpause(&s.pauser);
        }
        assert_eq!(
            s.env.auths(),
            std::vec![(
                s.pauser.clone(),
                invocation(&s, &s.contract.address, function, args, std::vec![])
            )]
        );
    }
}

#[test]
fn pause_refuses_everyone_but_the_pauser() {
    let s = common::setup_with_fee(0);
    let stranger = Address::generate(&s.env);
    for caller in [&stranger, &s.admin, &s.fee_admin, &s.upgrader] {
        sign(&s, caller, "pause", (caller,).into_val(&s.env));
        assert_eq!(
            s.contract.try_pause(caller),
            Err(Ok(soroban_sdk::Error::from_contract_error(UNAUTHORIZED)))
        );
    }
    // The pauser's address without its signature: the host reports the
    // failed `require_auth` to the caller as a context error.
    s.env.mock_auths(&[]);
    assert_eq!(
        s.contract.try_pause(&s.pauser),
        Err(Ok(soroban_sdk::Error::from_type_and_code(
            ScErrorType::Context,
            ScErrorCode::InvalidAction
        )))
    );
    assert!(!s.contract.paused());
}

#[test]
fn unpause_refuses_everyone_but_the_pauser() {
    let s = common::setup_with_fee(0);
    sign(&s, &s.pauser, "pause", (&s.pauser,).into_val(&s.env));
    s.contract.pause(&s.pauser);
    let stranger = Address::generate(&s.env);
    for caller in [&stranger, &s.admin, &s.fee_admin, &s.upgrader] {
        sign(&s, caller, "unpause", (caller,).into_val(&s.env));
        assert_eq!(
            s.contract.try_unpause(caller),
            Err(Ok(soroban_sdk::Error::from_contract_error(UNAUTHORIZED)))
        );
    }
    assert!(s.contract.paused());
}

#[test]
fn grant_role_is_authorized_by_the_admin_and_refused_to_others() {
    let s = common::setup_with_fee(0);
    let account = Address::generate(&s.env);
    let args: Vec<Val> = (&account, roles::PAUSER, &s.admin).into_val(&s.env);
    sign(&s, &s.admin, "grant_role", args.clone());
    s.contract.grant_role(&account, &roles::PAUSER, &s.admin);
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.admin.clone(),
            invocation(&s, &s.contract.address, "grant_role", args, std::vec![])
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
    assert_eq!(s.contract.has_role(&stranger, &roles::UPGRADER), None);
}

/// Deposits `amount` with a signed `deposit`, including its transfer.
fn deposit_signed(s: &Setup, id: u64, amount: i128) {
    s.env.mock_auths(&[MockAuth {
        address: &s.owner,
        invoke: &MockAuthInvoke {
            contract: &s.contract.address,
            fn_name: "deposit",
            args: (&s.owner, id, amount).into_val(&s.env),
            sub_invokes: &[MockAuthInvoke {
                contract: &s.token.address,
                fn_name: "transfer",
                args: (&s.owner, &s.contract.address, amount).into_val(&s.env),
                sub_invokes: &[],
            }],
        },
    }]);
    s.contract.deposit(&s.owner, &id, &amount);
}

/// Accrues 1% of 5,000 to the fee recipient, with every call signed.
fn accrue_signed(s: &Setup) {
    mint(s, &s.owner, 5_000);
    let id = create_signed(s);
    deposit_signed(s, id, 5_000);
    // The lock rule releases at the deadline.
    s.set_time(START + 10 * WEEK);
    sign(s, &s.owner, "withdraw", (&s.owner, id).into_val(&s.env));
    s.contract.withdraw(&s.owner, &id);
    assert_eq!(s.contract.accrued_fees(&s.fee_recipient), 50);
}

#[test]
fn claim_fees_is_authorized_by_the_recipient_only() {
    let s = common::setup_with_fee(100);
    accrue_signed(&s);
    let args: Vec<Val> = (&s.fee_recipient,).into_val(&s.env);
    sign(&s, &s.fee_recipient, "claim_fees", args.clone());
    assert_eq!(s.contract.claim_fees(&s.fee_recipient), 50);
    // The payout is the contract's own transfer, so no other signature.
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.fee_recipient.clone(),
            invocation(&s, &s.contract.address, "claim_fees", args, std::vec![])
        )]
    );
    assert_eq!(s.token.balance(&s.fee_recipient), 50);
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
    assert_eq!(s.contract.accrued_fees(&s.fee_recipient), 50);
    assert_eq!(s.token.balance(&s.fee_recipient), 0);
    // A stranger claiming as themselves has nothing accrued.
    sign(&s, &stranger, "claim_fees", (&stranger,).into_val(&s.env));
    assert_eq!(
        s.contract.try_claim_fees(&stranger),
        Err(Ok(Error::NothingToClaim))
    );
}

#[test]
fn create_goal_without_allowance_needs_only_the_owner() {
    // The per-owner id (W75) adds no signature: only the owner signs, with
    // no sub-invocation.
    let s = common::setup_with_fee(0);
    let args = create_args(&s, &s.owner, None);
    sign(&s, &s.owner, "create_goal", args.clone());
    let id = s.contract.create_goal(
        &s.owner,
        &10_000,
        &(START + 10 * WEEK),
        &WEEK,
        &1_000,
        &WithdrawalRule::Lock,
        &s.integrator,
        &0,
        &None,
    );
    assert_eq!(id, common::goal_id(&s.env, &s.owner, 0));
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.owner.clone(),
            invocation(&s, &s.contract.address, "create_goal", args, std::vec![])
        )]
    );
}
