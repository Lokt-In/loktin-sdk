//! Target Savings types and the client interface Spend & Save uses (P15,
//! S10). The Target Savings contract stores and returns these same types.

use soroban_sdk::{contractclient, contracttype, Address, Env};

/// What happens when the owner withdraws before the target or deadline (P4).
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WithdrawalRule {
    /// A penalty in basis points, at most 1,000, paid to the integrator.
    Penalty(u32),
    /// No withdrawal until the target is reached or the deadline passes.
    Lock,
}

/// An open savings goal.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Goal {
    pub id: u64,
    pub owner: Address,
    pub integrator: Address,
    pub integrator_fee_bps: u32,
    pub loktin_fee_bps: u32,
    pub target: i128,
    pub deadline: u64,
    pub cadence: u64,
    pub deposit_size: i128,
    pub rule: WithdrawalRule,
    pub start: u64,
    pub principal: i128,
    pub shares: i128,
    pub last_collected_period: u64,
    pub missed_count: u64,
}

/// The two Target Savings functions Spend & Save calls. The generated
/// `TargetSavingsApiClient` calls a deployed Target Savings contract.
#[contractclient(name = "TargetSavingsApiClient")]
pub trait TargetSavingsApi {
    /// Returns an open goal, or the Target Savings `GoalNotFound` error.
    fn goal(env: Env, id: u64) -> Result<Goal, soroban_sdk::Error>;

    /// Deposits `amount` from `owner` into their goal, under the owner's
    /// signature.
    fn deposit(
        env: Env,
        owner: Address,
        goal_id: u64,
        amount: i128,
    ) -> Result<(), soroban_sdk::Error>;
}
