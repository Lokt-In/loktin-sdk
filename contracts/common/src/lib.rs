//! Shared helpers for the Loktin contracts.
//!
//! Every helper here is pure and deterministic, except the TTL helpers, which
//! only extend storage lifetimes. This crate holds no contract and is never
//! deployed on its own. It also holds the Target Savings types and client
//! interface that Spend & Save uses to deposit into goals.

#![no_std]

#[cfg(feature = "testutils")]
pub mod budgets;
pub mod calendar;
pub mod errors;
pub mod events;
pub mod fees;
pub mod roles;
pub mod schedule;
pub mod target_savings;
pub mod ttl;

pub use errors::CommonError;
