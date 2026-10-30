//! The resource tests' limits (T10): a quarter of testnet's per-transaction
//! limits. Only compiled with the `testutils` feature, which only the
//! contracts' tests turn on.
//!
//! The limits were read on 2026-10-30 with
//! `stellar network settings --network testnet`.

extern crate std;

/// Testnet's per-transaction limits, as read on 2026-10-30.
pub struct Limits {
    pub instructions: i64,
    pub mem_bytes: i64,
    pub disk_read_entries: u32,
    pub disk_read_bytes: u32,
    pub write_entries: u32,
    pub write_bytes: u32,
    pub contract_events_size_bytes: u32,
}

/// `tx_max_instructions`, `tx_memory_limit`, `tx_max_disk_read_entries`,
/// `tx_max_disk_read_bytes`, `tx_max_write_ledger_entries`,
/// `tx_max_write_bytes` and `tx_max_contract_events_size_bytes`.
pub const TESTNET: Limits = Limits {
    instructions: 400_000_000,
    mem_bytes: 41_943_040,
    disk_read_entries: 200,
    disk_read_bytes: 200_000,
    write_entries: 200,
    write_bytes: 132_096,
    contract_events_size_bytes: 16_384,
};

/// Each measure must stay under this share of the testnet limit, in percent.
pub const SHARE_PERCENT: u32 = 25;

/// The seven figures of one invocation, from
/// `env.cost_estimate().resources()`. Build it with [`measured!`].
#[derive(Clone, Copy, Debug)]
pub struct Measured {
    pub instructions: i64,
    pub mem_bytes: i64,
    pub disk_read_entries: u32,
    pub disk_read_bytes: u32,
    pub write_entries: u32,
    pub write_bytes: u32,
    pub contract_events_size_bytes: u32,
}

/// The [`Measured`] figures of the last top-level invocation in `env`.
/// A macro, because soroban-sdk does not export the resources' type.
#[macro_export]
macro_rules! measured {
    ($env:expr) => {{
        let r = $env.cost_estimate().resources();
        $crate::budgets::Measured {
            instructions: r.instructions,
            mem_bytes: r.mem_bytes,
            disk_read_entries: r.disk_read_entries,
            disk_read_bytes: r.disk_read_bytes,
            write_entries: r.write_entries,
            write_bytes: r.write_bytes,
            contract_events_size_bytes: r.contract_events_size_bytes,
        }
    }};
}

fn line(limit: i64) -> i64 {
    limit * i64::from(SHARE_PERCENT) / 100
}

/// Prints one line with the seven figures of `function`, then asserts that
/// each is under [`SHARE_PERCENT`] of the testnet limit.
pub fn check(contract: &str, function: &str, m: &Measured) {
    let t = &TESTNET;
    std::println!(
        "budget {contract} {function}: instructions {} mem_bytes {} disk_read_entries {} \
         disk_read_bytes {} write_entries {} write_bytes {} events_bytes {}",
        m.instructions,
        m.mem_bytes,
        m.disk_read_entries,
        m.disk_read_bytes,
        m.write_entries,
        m.write_bytes,
        m.contract_events_size_bytes,
    );
    let figures = [
        ("instructions", m.instructions, t.instructions),
        ("mem_bytes", m.mem_bytes, t.mem_bytes),
        (
            "disk_read_entries",
            i64::from(m.disk_read_entries),
            i64::from(t.disk_read_entries),
        ),
        (
            "disk_read_bytes",
            i64::from(m.disk_read_bytes),
            i64::from(t.disk_read_bytes),
        ),
        (
            "write_entries",
            i64::from(m.write_entries),
            i64::from(t.write_entries),
        ),
        (
            "write_bytes",
            i64::from(m.write_bytes),
            i64::from(t.write_bytes),
        ),
        (
            "events_bytes",
            i64::from(m.contract_events_size_bytes),
            i64::from(t.contract_events_size_bytes),
        ),
    ];
    for (name, value, limit) in figures {
        assert!(
            value < line(limit),
            "{contract} {function}: {name} is {value}, not under {SHARE_PERCENT}% of the testnet limit {limit} ({})",
            line(limit),
        );
    }
}
