//! T3: random sequences of enrol, pay_and_save, save_for_spend, settings
//! changes, withdrawals in and out of the window, fee changes, fee claims
//! and month changes, checking the money rules after every step.

mod common;

use std::collections::BTreeMap;

use common::{Setup, DAY, START, WEEK};
use loktin_spend_save::{Destination, Error, SkimSettings};
use proptest::prelude::*;
use soroban_sdk::testutils::{Address as _, EnvTestConfig};
use soroban_sdk::{Address, Env, MuxedAddress};

const USERS: usize = 2;
const INTEGRATORS: usize = 2;
const FUNDS: i128 = 40_000;

#[derive(Clone, Debug)]
struct Settings {
    percent_bps: Option<u32>,
    round_up_unit: Option<i128>,
    monthly_cap: Option<i128>,
    to_goal: bool,
    day: u32,
}

#[derive(Clone, Debug)]
enum Op {
    Enroll {
        user: usize,
        integrator: usize,
        integrator_fee_bps: u32,
        settings: Settings,
    },
    Update {
        user: usize,
        integrator: usize,
        settings: Settings,
    },
    Pay {
        user: usize,
        integrator: usize,
        amount: i128,
    },
    Save {
        user: usize,
        integrator: usize,
        spent: i128,
    },
    /// Withdraws `permille` thousandths of the balance: 0 and anything above
    /// 1,000 are refused. With `in_window`, time first moves into the
    /// enrolment's next window.
    Withdraw {
        user: usize,
        integrator: usize,
        permille: i128,
        in_window: bool,
        offset: u64,
    },
    Close {
        user: usize,
        integrator: usize,
    },
    SetFee {
        loktin_fee_bps: u32,
    },
    /// Claims for one of the integrators or the fee recipient.
    Claim {
        recipient: usize,
    },
    Advance {
        seconds: u64,
    },
    /// Moves time to a random second inside an enrolment's next window.
    ToWindow {
        user: usize,
        integrator: usize,
        offset: u64,
    },
}

fn settings() -> impl Strategy<Value = Settings> {
    (
        prop::option::of(50..=5_100_u32),
        // Mostly small units, sometimes ones far above any spend.
        prop::option::of(prop_oneof![3 => -1..=500_i128, 1 => 1..=i128::MAX]),
        prop::option::of(-1..=3_000_i128),
        any::<bool>(),
        0..=29_u32,
    )
        .prop_map(
            |(percent_bps, round_up_unit, monthly_cap, to_goal, day)| Settings {
                percent_bps,
                round_up_unit,
                monthly_cap,
                to_goal,
                day,
            },
        )
}

fn op() -> impl Strategy<Value = Op> {
    let who = (0..USERS, 0..INTEGRATORS);
    prop_oneof![
        2 => (who.clone(), 0..=110_u32, settings()).prop_map(|((user, integrator), fee, settings)| {
            Op::Enroll { user, integrator, integrator_fee_bps: fee, settings }
        }),
        1 => (who.clone(), settings()).prop_map(|((user, integrator), settings)| {
            Op::Update { user, integrator, settings }
        }),
        3 => (who.clone(), -10..=30_000_i128).prop_map(|((user, integrator), amount)| {
            Op::Pay { user, integrator, amount }
        }),
        5 => (who.clone(), -10..=20_000_i128).prop_map(|((user, integrator), spent)| {
            Op::Save { user, integrator, spent }
        }),
        3 => (who.clone(), 0..=1_100_i128, any::<bool>(), 0..DAY).prop_map(
            |((user, integrator), permille, in_window, offset)| {
                Op::Withdraw { user, integrator, permille, in_window, offset }
            }
        ),
        1 => who.clone().prop_map(|(user, integrator)| Op::Close { user, integrator }),
        1 => (0..=120_u32).prop_map(|loktin_fee_bps| Op::SetFee { loktin_fee_bps }),
        1 => any::<usize>().prop_map(|recipient| Op::Claim { recipient }),
        3 => (0..=20 * DAY).prop_map(|seconds| Op::Advance { seconds }),
        2 => (who, 0..DAY).prop_map(|((user, integrator), offset)| {
            Op::ToWindow { user, integrator, offset }
        }),
    ]
}

/// The tracked fees of one recipient. A list, since `Address` cannot be a
/// map key under clippy.
fn owed<'a>(accrued: &'a mut [(Address, i128)], recipient: &Address) -> &'a mut i128 {
    &mut accrued
        .iter_mut()
        .find(|(who, _)| who == recipient)
        .expect("a tracked recipient")
        .1
}

/// The fee rates an enrolment was created with.
type Rates = (u32, u32);

struct Run<'a> {
    s: Setup<'a>,
    users: std::vec::Vec<Address>,
    integrators: std::vec::Vec<Address>,
    goals: std::vec::Vec<u64>,
    rates: BTreeMap<(usize, usize), Rates>,
    /// The fees each recipient should have accrued and not yet claimed.
    accrued: std::vec::Vec<(Address, i128)>,
}

impl Run<'_> {
    fn new() -> Self {
        let env = common::with_ledger(Env::new_with_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        }));
        let s = common::setup_in(env, 0, true);
        s.env.mock_all_auths();
        let users: std::vec::Vec<Address> = (0..USERS).map(|_| Address::generate(&s.env)).collect();
        let integrators: std::vec::Vec<Address> = (0..INTEGRATORS)
            .map(|_| Address::generate(&s.env))
            .collect();
        let accrued = integrators
            .iter()
            .chain([&s.fee_recipient])
            .map(|recipient| (recipient.clone(), 0))
            .collect::<std::vec::Vec<_>>();
        // One Target Savings goal per user, to aim skims at.
        let goals = users
            .iter()
            .map(|user| {
                s.mint(user, FUNDS);
                s.savings.create_goal(
                    user,
                    &20_000,
                    &(START + 8 * WEEK),
                    &WEEK,
                    &1,
                    &loktin_target_savings::WithdrawalRule::Lock,
                    &s.integrator,
                    &0,
                    &None,
                )
            })
            .collect();
        Run {
            s,
            users,
            integrators,
            goals,
            rates: BTreeMap::new(),
            accrued,
        }
    }

    fn skim(settings: &Settings) -> SkimSettings {
        SkimSettings {
            percent_bps: settings.percent_bps,
            round_up_unit: settings.round_up_unit,
        }
    }

    fn destination(&self, user: usize, settings: &Settings) -> Destination {
        if settings.to_goal {
            Destination::Goal(self.goals[user])
        } else {
            Destination::Balance
        }
    }

    /// Saves through `save`, checking the result against a preview taken
    /// just before.
    fn checked_save(
        &self,
        user: usize,
        integrator: usize,
        spent: i128,
        save: impl FnOnce() -> Option<loktin_spend_save::Saving>,
    ) {
        let c = &self.s.contract;
        let preview = c.try_preview_skim(&self.users[user], &self.integrators[integrator], &spent);
        let Some(saving) = save() else { return };
        // The preview always matches what happens.
        let Ok(Ok(preview)) = preview else {
            panic!("saved where the preview failed");
        };
        assert_eq!(saving.skim, preview.skim);
        // A skim never exceeds the spend (P12).
        assert!(saving.skim <= spent);
        assert_eq!(saving.cap_trimmed, preview.cap_trimmed);
        assert_eq!(
            saving.to_balance + saving.to_goal + saving.shortfall,
            preview.capped
        );
        assert!(saving.to_balance >= 0 && saving.to_goal >= 0 && saving.shortfall >= 0);
        // A save never takes saved_this_month above the cap. The cap can be
        // lowered mid-month below what was already saved, so this is checked
        // at each save, not between saves.
        let e = c.enrollment(&self.users[user], &self.integrators[integrator]);
        if let Some(cap) = e.monthly_cap {
            let saved = saving.to_balance + saving.to_goal;
            assert!(saved == 0 || e.saved_this_month <= cap, "{e:?}");
        }
    }

    fn apply(&mut self, op: &Op) {
        let c = &self.s.contract;
        match op {
            Op::Enroll {
                user,
                integrator,
                integrator_fee_bps,
                settings,
            } => {
                let result = c.try_enroll(
                    &self.users[*user],
                    &self.integrators[*integrator],
                    integrator_fee_bps,
                    &Self::skim(settings),
                    &settings.monthly_cap,
                    &self.destination(*user, settings),
                    &settings.day,
                );
                if let Ok(Ok(())) = result {
                    let e = c.enrollment(&self.users[*user], &self.integrators[*integrator]);
                    self.rates.insert(
                        (*user, *integrator),
                        (e.loktin_fee_bps, e.integrator_fee_bps),
                    );
                }
            }
            Op::Update {
                user,
                integrator,
                settings,
            } => {
                let _ = c.try_update_settings(
                    &self.users[*user],
                    &self.integrators[*integrator],
                    &Self::skim(settings),
                    &settings.monthly_cap,
                    &self.destination(*user, settings),
                    &settings.day,
                );
            }
            Op::Pay {
                user,
                integrator,
                amount,
            } => {
                let to = MuxedAddress::from(&self.s.payee);
                self.checked_save(*user, *integrator, *amount, || {
                    match c.try_pay_and_save(
                        &self.users[*user],
                        &self.integrators[*integrator],
                        &to,
                        amount,
                    ) {
                        Ok(Ok(saving)) => Some(saving),
                        _ => None,
                    }
                });
            }
            Op::Save {
                user,
                integrator,
                spent,
            } => {
                self.checked_save(*user, *integrator, *spent, || {
                    match c.try_save_for_spend(
                        &self.users[*user],
                        &self.integrators[*integrator],
                        spent,
                    ) {
                        Ok(Ok(saving)) => Some(saving),
                        _ => None,
                    }
                });
            }
            Op::Withdraw {
                user,
                integrator,
                permille,
                in_window,
                offset,
            } => {
                if *in_window {
                    self.apply(&Op::ToWindow {
                        user: *user,
                        integrator: *integrator,
                        offset: *offset,
                    });
                }
                let c = &self.s.contract;
                let user_address = &self.users[*user];
                let integrator_address = &self.integrators[*integrator];
                let before = c.try_enrollment(user_address, integrator_address);
                let principal = match &before {
                    Ok(Ok(e)) => e.principal,
                    _ => 1_000,
                };
                let amount = &(principal * permille / 1_000);
                let balance = |who: &Address| self.s.token.balance(who);
                let contract_before = balance(&c.address);
                let integrator_before = balance(integrator_address);
                let recipient_before = balance(&self.s.fee_recipient);
                let integrator_accrued = c.accrued_fees(integrator_address);
                let recipient_accrued = c.accrued_fees(&self.s.fee_recipient);
                match c.try_withdraw(user_address, integrator_address, amount) {
                    Ok(Ok(w)) => {
                        // Every withdrawal's parts sum exactly to the amount.
                        assert_eq!(w.amount, *amount);
                        assert_eq!(w.loktin_fee + w.integrator_fee + w.to_user, *amount);
                        let Ok(Ok(before)) = before else {
                            panic!("withdrew from a missing enrolment");
                        };
                        let after = c.enrollment(user_address, integrator_address);
                        assert_eq!(before.principal - after.principal, *amount);
                        // Only the user is paid. The fees accrue and stay in
                        // the contract until claimed.
                        assert_eq!(contract_before - balance(&c.address), w.to_user);
                        assert_eq!(balance(integrator_address), integrator_before);
                        assert_eq!(balance(&self.s.fee_recipient), recipient_before);
                        assert_eq!(
                            c.accrued_fees(integrator_address) - integrator_accrued,
                            w.integrator_fee
                        );
                        assert_eq!(
                            c.accrued_fees(&self.s.fee_recipient) - recipient_accrued,
                            w.loktin_fee
                        );
                        *owed(&mut self.accrued, integrator_address) += w.integrator_fee;
                        *owed(&mut self.accrued, &self.s.fee_recipient) += w.loktin_fee;
                    }
                    Err(Ok(
                        Error::OutsideWindow
                        | Error::ExceedsBalance
                        | Error::InvalidAmount
                        | Error::EnrollmentNotFound,
                    )) => {}
                    other => panic!("unexpected withdraw result {other:?}"),
                }
            }
            Op::Close { user, integrator } => {
                if let Ok(Ok(())) = c.try_close(&self.users[*user], &self.integrators[*integrator])
                {
                    self.rates.remove(&(*user, *integrator));
                }
            }
            Op::SetFee { loktin_fee_bps } => {
                let _ = c.try_set_loktin_fee(loktin_fee_bps, &self.s.fee_admin);
            }
            Op::Claim { recipient } => {
                let (recipient, expected) = self.accrued[recipient % self.accrued.len()].clone();
                let before = self.s.token.balance(&recipient);
                match c.try_claim_fees(&recipient) {
                    Ok(Ok(amount)) => {
                        assert_eq!(amount, expected);
                        assert_eq!(self.s.token.balance(&recipient) - before, expected);
                        *owed(&mut self.accrued, &recipient) = 0;
                    }
                    Err(Ok(Error::NothingToClaim)) => assert_eq!(expected, 0),
                    other => panic!("unexpected claim result {other:?}"),
                }
            }
            Op::Advance { seconds } => {
                self.s.set_time(self.s.env.ledger().timestamp() + seconds);
            }
            Op::ToWindow {
                user,
                integrator,
                offset,
            } => {
                if let Ok(Ok((start, _))) =
                    c.try_next_window(&self.users[*user], &self.integrators[*integrator])
                {
                    let now = self.s.env.ledger().timestamp();
                    self.s.set_time((start + offset).max(now));
                }
            }
        }
    }

    fn check(&self) {
        let c = &self.s.contract;
        let mut principals = 0;
        for user in 0..USERS {
            for integrator in 0..INTEGRATORS {
                let result = c.try_enrollment(&self.users[user], &self.integrators[integrator]);
                match (result, self.rates.get(&(user, integrator))) {
                    (Ok(Ok(e)), Some(rates)) => {
                        // Fee rates never change.
                        assert_eq!((e.loktin_fee_bps, e.integrator_fee_bps), *rates);
                        assert_eq!(e.shares, e.principal);
                        assert!(e.principal >= 0);
                        assert!(e.saved_this_month <= e.total_saved);
                        principals += e.principal;
                    }
                    (Err(Ok(Error::EnrollmentNotFound)), None) => {}
                    other => panic!("enrolment and record disagree: {other:?}"),
                }
            }
        }
        let mut accrued = 0;
        for (recipient, expected) in &self.accrued {
            assert_eq!(c.accrued_fees(recipient), *expected);
            accrued += expected;
        }
        // Principals plus unclaimed fees equal the contract's token balance.
        assert_eq!(principals + accrued, self.s.token.balance(&c.address));
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(128))]

    #[test]
    fn money_rules_hold_after_every_step(ops in prop::collection::vec(op(), 1..60)) {
        let mut run = Run::new();
        for op in &ops {
            run.apply(op);
            run.check();
        }
    }
}
