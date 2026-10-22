//! Storage TTL renewal (S1).

use soroban_sdk::{Env, IntoVal, Val};

/// Remaining TTL, in ledgers, below which an entry is extended. About 30 days
/// at the 5-second target close time.
pub const TTL_THRESHOLD: u32 = 518_400;

/// Extends the current contract's instance and code TTL to
/// [`max_ttl`](soroban_sdk::storage::Storage::max_ttl) when the remaining TTL
/// is below [`TTL_THRESHOLD`].
pub fn extend_instance(env: &Env) {
    let max_ttl = env.storage().max_ttl();
    env.storage().instance().extend_ttl(TTL_THRESHOLD, max_ttl);
}

/// Extends the TTL of the persistent entry under `key` to
/// [`max_ttl`](soroban_sdk::storage::Storage::max_ttl) when the remaining TTL
/// is below [`TTL_THRESHOLD`].
///
/// The host traps if no entry exists under `key`, so call this only for an
/// entry the caller has just read or written.
pub fn extend_persistent<K>(env: &Env, key: &K)
where
    K: IntoVal<Env, Val>,
{
    let max_ttl = env.storage().max_ttl();
    env.storage()
        .persistent()
        .extend_ttl(key, TTL_THRESHOLD, max_ttl);
}
