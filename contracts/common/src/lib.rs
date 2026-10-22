//! Shared helpers for the Loktin contracts.
//!
//! Every helper here is pure and deterministic, except the TTL helpers, which
//! only extend storage lifetimes. This crate holds no contract and is never
//! deployed on its own.

#![no_std]

pub mod calendar;
pub mod errors;
pub mod fees;
pub mod roles;
pub mod schedule;
pub mod ttl;

pub use errors::CommonError;
