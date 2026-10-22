//! The client interface in `contracts/common` matches the real contract.

mod common;

use loktin_common::target_savings::TargetSavingsApiClient;
use loktin_target_savings::WithdrawalRule;

#[test]
fn common_client_reads_and_deposits() {
    let s = common::setup();
    s.mint(&s.owner, 1_000);
    let id = s.create_default(WithdrawalRule::Lock);
    let api = TargetSavingsApiClient::new(&s.env, &s.contract.address);
    assert_eq!(api.goal(&id), s.contract.goal(&id));
    api.deposit(&s.owner, &id, &400);
    assert_eq!(s.contract.goal(&id).principal, 400);
    // Errors come back with Target Savings codes.
    assert_eq!(
        api.try_goal(&99),
        Err(Ok(soroban_sdk::Error::from_contract_error(100)))
    );
    assert_eq!(
        api.try_deposit(&s.owner, &id, &9_601),
        Err(Ok(soroban_sdk::Error::from_contract_error(113)))
    );
}
