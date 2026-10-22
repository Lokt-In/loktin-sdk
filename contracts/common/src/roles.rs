//! Role names used with the OpenZeppelin access control module (C2).

use soroban_sdk::{symbol_short, Symbol};

/// Sets the Loktin fee rate for new goals and the Loktin fee recipient (R6).
pub const FEE_ADMIN: Symbol = symbol_short!("fee_admin");

/// Pauses and unpauses the contract (C4).
pub const PAUSER: Symbol = symbol_short!("pauser");

/// Replaces the contract code (C5).
pub const UPGRADER: Symbol = symbol_short!("upgrader");
