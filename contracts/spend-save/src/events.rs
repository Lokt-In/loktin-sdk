//! Events (S6). Names and fields are documented in `docs/events.md`.

use soroban_sdk::{contractevent, Address, MuxedAddress};

pub use loktin_common::events::{FeeRecipientSet, LoktinFeeSet, Upgraded};

use crate::storage::{DayChange, Destination, SkimSettings};

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Enrolled {
    #[topic]
    pub user: Address,
    #[topic]
    pub integrator: Address,
    pub integrator_fee_bps: u32,
    pub loktin_fee_bps: u32,
    pub skim: SkimSettings,
    pub monthly_cap: Option<i128>,
    pub destination: Destination,
    pub withdrawal_day: u32,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettingsUpdated {
    #[topic]
    pub user: Address,
    #[topic]
    pub integrator: Address,
    pub skim: SkimSettings,
    pub monthly_cap: Option<i128>,
    pub destination: Destination,
    pub withdrawal_day: u32,
    pub pending_day: DayChange,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Saved {
    #[topic]
    pub user: Address,
    #[topic]
    pub integrator: Address,
    pub spent: i128,
    pub skim: i128,
    pub cap_trimmed: i128,
    pub shortfall: i128,
    pub to_balance: i128,
    pub to_goal: i128,
    pub goal_id: Option<u64>,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Paid {
    #[topic]
    pub user: Address,
    #[topic]
    pub integrator: Address,
    pub to: MuxedAddress,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Withdrawn {
    #[topic]
    pub user: Address,
    #[topic]
    pub integrator: Address,
    pub amount: i128,
    pub loktin_fee: i128,
    pub integrator_fee: i128,
    pub to_user: i128,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnrollmentClosed {
    #[topic]
    pub user: Address,
    #[topic]
    pub integrator: Address,
}
