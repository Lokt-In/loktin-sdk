//! Events (S6). Names and fields are documented in `docs/events.md`.

use soroban_sdk::{contractevent, contracttype, Address};

pub use loktin_common::events::{FeeRecipientSet, FeesClaimed, LoktinFeeSet, Upgraded};

use crate::storage::WithdrawalRule;

/// How a deposit reached a goal.
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DepositKind {
    /// Made by the owner with `deposit`.
    Manual,
    /// Collected for a due period with `collect`.
    Scheduled,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GoalCreated {
    #[topic]
    pub goal_id: u64,
    #[topic]
    pub owner: Address,
    pub integrator: Address,
    pub target: i128,
    pub deadline: u64,
    pub cadence: u64,
    pub deposit_size: i128,
    pub rule: WithdrawalRule,
    pub start: u64,
    pub loktin_fee_bps: u32,
    pub integrator_fee_bps: u32,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Deposited {
    #[topic]
    pub goal_id: u64,
    #[topic]
    pub owner: Address,
    pub kind: DepositKind,
    pub amount: i128,
    pub principal: i128,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Missed {
    #[topic]
    pub goal_id: u64,
    pub periods: u64,
    pub missed_count: u64,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Withdrawn {
    #[topic]
    pub goal_id: u64,
    #[topic]
    pub owner: Address,
    pub amount: i128,
    pub penalty: i128,
    pub loktin_fee: i128,
    pub integrator_fee: i128,
    pub to_user: i128,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GoalClosed {
    #[topic]
    pub goal_id: u64,
    #[topic]
    pub owner: Address,
}
