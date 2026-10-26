//! T3: random sequences of create, deposit, collect, withdraw, fee changes
//! and fee claims, with the ledger time advanced, checking the money rules
//! after every step.

mod common;

use std::collections::{BTreeMap, BTreeSet};

use common::{Setup, DAY, WEEK};
use loktin_common::schedule::current_period;
use loktin_target_savings::{Error, WithdrawalRule};
use proptest::prelude::*;
use soroban_sdk::testutils::{Address as _, EnvTestConfig};
use soroban_sdk::{Address, Env};

const OWNERS: usize = 2;
const FUNDS: i128 = 1_000_000_000;

#[derive(Clone, Debug)]
enum Op {
    Create {
        owner: usize,
        target: i128,
        deposit_size: i128,
        cadence_days: u64,
        periods: u64,
        lock: bool,
        penalty_bps: u32,
        integrator_fee_bps: u32,
    },
    Deposit {
        goal: usize,
        amount: i128,
    },
    Collect {
        goal: usize,
    },
    Withdraw {
        goal: usize,
    },
    SetFee {
        loktin_fee_bps: u32,
    },
    /// Claims for the integrator (even) or the fee recipient (odd).
    Claim {
        recipient: usize,
    },
    Advance {
        seconds: u64,
    },
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        2 => (
            0..OWNERS,
            1..50_000_i128,
            1..20_000_i128,
            1..=14_u64,
            1..=10_u64,
            any::<bool>(),
            0..=1_100_u32,
            0..=110_u32,
        )
            .prop_map(
                |(owner, target, deposit_size, cadence_days, periods, lock, penalty_bps, fee)| {
                    Op::Create {
                        owner,
                        target,
                        deposit_size,
                        cadence_days,
                        periods,
                        lock,
                        penalty_bps,
                        integrator_fee_bps: fee,
                    }
                }
            ),
        3 => (any::<usize>(), -10..8_000_i128).prop_map(|(goal, amount)| Op::Deposit { goal, amount }),
        4 => any::<usize>().prop_map(|goal| Op::Collect { goal }),
        1 => any::<usize>().prop_map(|goal| Op::Withdraw { goal }),
        1 => (0..=120_u32).prop_map(|loktin_fee_bps| Op::SetFee { loktin_fee_bps }),
        1 => any::<usize>().prop_map(|recipient| Op::Claim { recipient }),
        3 => (0..=2 * WEEK).prop_map(|seconds| Op::Advance { seconds }),
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

/// What the test remembers about each goal it created.
struct Tracked {
    open: bool,
    owner: Address,
    loktin_fee_bps: u32,
    collected: BTreeSet<u64>,
}

struct Run<'a> {
    s: Setup<'a>,
    owners: std::vec::Vec<Address>,
    goals: BTreeMap<u64, Tracked>,
    /// The fees each recipient should have accrued and not yet claimed.
    accrued: std::vec::Vec<(Address, i128)>,
}

impl Run<'_> {
    fn new() -> Self {
        let env = common::with_ledger(Env::new_with_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        }));
        let s = common::setup_in(env, 0);
        s.env.mock_all_auths();
        let owners: std::vec::Vec<Address> =
            (0..OWNERS).map(|_| Address::generate(&s.env)).collect();
        for owner in &owners {
            s.mint(owner, FUNDS);
        }
        let accrued = std::vec![(s.integrator.clone(), 0), (s.fee_recipient.clone(), 0)];
        Run {
            s,
            owners,
            goals: BTreeMap::new(),
            accrued,
        }
    }

    /// Picks one of the goals created so far, open or closed.
    fn pick(&self, index: usize) -> Option<u64> {
        let ids: std::vec::Vec<u64> = self.goals.keys().copied().collect();
        (!ids.is_empty()).then(|| ids[index % ids.len()])
    }

    fn apply(&mut self, op: &Op) {
        let s = &self.s;
        let c = &s.contract;
        match *op {
            Op::Create {
                owner,
                target,
                deposit_size,
                cadence_days,
                periods,
                lock,
                penalty_bps,
                integrator_fee_bps,
            } => {
                let owner = &self.owners[owner];
                let cadence = cadence_days * DAY;
                let deadline = s.env.ledger().timestamp() + cadence * periods;
                let rule = if lock {
                    WithdrawalRule::Lock
                } else {
                    WithdrawalRule::Penalty(penalty_bps)
                };
                let result = c.try_create_goal(
                    owner,
                    &target,
                    &deadline,
                    &cadence,
                    &deposit_size,
                    &rule,
                    &s.integrator,
                    &integrator_fee_bps,
                    &s.allowance(FUNDS),
                );
                if let Ok(Ok(id)) = result {
                    let goal = c.goal(&id);
                    self.goals.insert(
                        id,
                        Tracked {
                            open: true,
                            owner: owner.clone(),
                            loktin_fee_bps: goal.loktin_fee_bps,
                            collected: BTreeSet::new(),
                        },
                    );
                }
            }
            Op::Deposit { goal, amount } => {
                if let Some(id) = self.pick(goal) {
                    let owner = self.goals[&id].owner.clone();
                    let _ = c.try_deposit(&owner, &id, &amount);
                }
            }
            Op::Collect { goal } => {
                let Some(id) = self.pick(goal) else { return };
                let before = c.try_goal(&id);
                if let Ok(Ok(())) = c.try_collect(&id) {
                    let Ok(Ok(before)) = before else {
                        panic!("collected a goal that was not open");
                    };
                    // No collection succeeds after the deadline.
                    assert!(s.env.ledger().timestamp() <= before.deadline);
                    let period =
                        current_period(before.start, before.cadence, s.env.ledger().timestamp())
                            .unwrap()
                            .unwrap();
                    // At most one collection per period.
                    assert!(self.goals.get_mut(&id).unwrap().collected.insert(period));
                    assert!(period > before.last_collected_period);
                }
            }
            Op::Withdraw { goal } => {
                let Some(id) = self.pick(goal) else { return };
                let owner = self.goals[&id].owner.clone();
                let before = c.try_goal(&id);
                let balances = |who: &Address| s.token.balance(who);
                let owner_before = balances(&owner);
                let integrator_before = balances(&s.integrator);
                let recipient_before = balances(&s.fee_recipient);
                let contract_before = balances(&c.address);
                let integrator_accrued = c.accrued_fees(&s.integrator);
                let recipient_accrued = c.accrued_fees(&s.fee_recipient);
                match c.try_withdraw(&owner, &id) {
                    Ok(Ok(w)) => {
                        let Ok(Ok(before)) = before else {
                            panic!("withdrew a goal that was not open");
                        };
                        // Every part sums exactly to the principal.
                        assert_eq!(w.amount, before.principal);
                        assert_eq!(
                            w.penalty + w.loktin_fee + w.integrator_fee + w.to_user,
                            before.principal
                        );
                        assert!(w.to_user >= 0);
                        // Only the owner is paid. The penalty and fees accrue
                        // and stay in the contract until claimed.
                        assert_eq!(balances(&owner) - owner_before, w.to_user);
                        assert_eq!(balances(&s.integrator), integrator_before);
                        assert_eq!(balances(&s.fee_recipient), recipient_before);
                        assert_eq!(
                            c.accrued_fees(&s.integrator) - integrator_accrued,
                            w.penalty + w.integrator_fee
                        );
                        assert_eq!(
                            c.accrued_fees(&s.fee_recipient) - recipient_accrued,
                            w.loktin_fee
                        );
                        assert_eq!(contract_before - balances(&c.address), w.to_user);
                        *owed(&mut self.accrued, &s.integrator) += w.penalty + w.integrator_fee;
                        *owed(&mut self.accrued, &s.fee_recipient) += w.loktin_fee;
                        self.goals.get_mut(&id).unwrap().open = false;
                    }
                    Err(Ok(Error::Locked)) | Err(Ok(Error::GoalNotFound)) => {}
                    other => panic!("unexpected withdraw result {other:?}"),
                }
            }
            Op::SetFee { loktin_fee_bps } => {
                let _ = c.try_set_loktin_fee(&loktin_fee_bps, &s.fee_admin);
            }
            Op::Claim { recipient } => {
                let recipient = if recipient % 2 == 0 {
                    s.integrator.clone()
                } else {
                    s.fee_recipient.clone()
                };
                let expected = *owed(&mut self.accrued, &recipient);
                let before = s.token.balance(&recipient);
                match c.try_claim_fees(&recipient) {
                    Ok(Ok(amount)) => {
                        assert_eq!(amount, expected);
                        assert_eq!(s.token.balance(&recipient) - before, expected);
                        *owed(&mut self.accrued, &recipient) = 0;
                    }
                    Err(Ok(Error::NothingToClaim)) => assert_eq!(expected, 0),
                    other => panic!("unexpected claim result {other:?}"),
                }
            }
            Op::Advance { seconds } => {
                s.set_time(s.env.ledger().timestamp() + seconds);
                s.advance_ledgers(u32::try_from(seconds / 5).unwrap());
            }
        }
    }

    fn check(&self) {
        let c = &self.s.contract;
        let mut open_principal = 0;
        for (id, tracked) in &self.goals {
            match c.try_goal(id) {
                Ok(Ok(goal)) => {
                    assert!(tracked.open, "goal {id} reappeared");
                    // The Loktin fee rate never changes after creation.
                    assert_eq!(goal.loktin_fee_bps, tracked.loktin_fee_bps);
                    assert_eq!(goal.shares, goal.principal);
                    assert!(goal.principal >= 0 && goal.principal <= goal.target);
                    open_principal += goal.principal;
                }
                Err(Ok(Error::GoalNotFound)) => {
                    // A goal only disappears through a successful withdraw.
                    assert!(!tracked.open, "goal {id} closed without a withdrawal");
                }
                other => panic!("unexpected goal read {other:?}"),
            }
        }
        let mut accrued = 0;
        for (recipient, expected) in &self.accrued {
            assert_eq!(c.accrued_fees(recipient), *expected);
            accrued += expected;
        }
        // Open principals plus unclaimed fees equal the contract's token
        // balance.
        assert_eq!(open_principal + accrued, self.s.token.balance(&c.address));
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(128))]

    #[test]
    fn money_rules_hold_after_every_step(ops in prop::collection::vec(op(), 1..40)) {
        let mut run = Run::new();
        for op in &ops {
            run.apply(op);
            run.check();
        }
    }
}
