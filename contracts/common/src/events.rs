//! Events both contracts emit (S6). Documented in `docs/events.md`.

use soroban_sdk::{contractevent, Address, BytesN};

/// The Loktin fee rate for goals and enrolments created from now on.
#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoktinFeeSet {
    pub loktin_fee_bps: u32,
}

/// The address Loktin fees are paid to.
#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeeRecipientSet {
    pub fee_recipient: Address,
}

/// The contract code is being replaced.
#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Upgraded {
    pub new_wasm_hash: BytesN<32>,
    pub operator: Address,
}
