# @loktin/sdk

A TypeScript SDK for Loktin's savings contracts on Stellar. It has no user interface: your app supplies the screens and the wallet, and the SDK builds, checks, signs and sends the contract calls. It covers two savings primitives:

- **Target Savings**: the user saves toward a target by a deadline, with scheduled deposits that the contract collects and deposits the user makes by hand.
- **Spend & Save**: each time the user spends, a share of the spend is saved, either to a Spend & Save balance or into a Target Savings goal. The balance can be withdrawn on one day each month.

## Status

- This is the preview release, `0.4.0`. Its API may change before `1.0.0`.
- It works on Stellar testnet only. The contracts have no mainnet deployment, and the SDK refuses the public network.
- It is designed for browsers and Node. Browser support will be confirmed with the reference app, and is not claimed yet.

## Install

```sh
npm install @loktin/sdk@next @stellar/stellar-sdk
```

`@stellar/stellar-sdk` is a peer dependency. Your app and the SDK then share one copy of it, so the wallet types and XDR values your app passes in are the ones the SDK expects, and your bundle holds stellar-sdk once. The SDK needs version 17.2.1 or a later 17.x.

## Quick start

Create one SDK instance for testnet with the user's address and a signer. The signer's `signTransaction` comes from the user's wallet, in the shape stellar-sdk and SEP-43 wallets use. The SDK never sees a secret key. Each module works for one integrator, which is your app's address, and takes your integrator fee in basis points.

```ts
import { createLoktin } from '@loktin/sdk';
import { SpendSave } from '@loktin/sdk/spend-save';
import { TargetSavings } from '@loktin/sdk/target-savings';

const loktin = createLoktin({
  network: 'testnet',
  publicKey: userAddress,
  signer: {
    signTransaction: (xdr, opts) => wallet.signTransaction(xdr, opts),
  },
});
const options = { integrator: integratorAddress, integratorFeeBps: 50 };
const targetSavings = new TargetSavings(loktin, options);
const spendSave = new SpendSave(loktin, options);
```

Here `userAddress`, `integratorAddress` and `wallet` come from your app. Every write acts for `publicKey`, and every input the contracts would refuse without needing chain data is refused before any network call.

Every RPC request has a time limit of 30 seconds. Set `requestTimeoutMs` in `createLoktin` to change it. A request that runs out of time counts as a network error and is handled the same way. The limit applies to the RPC connection the SDK builds, not to a `server` you pass in.

## Target Savings

`createGoal` creates a goal and returns its id. Amounts are `bigint` base units: USDC has 7 decimals, and `toBaseUnits` and `fromBaseUnits` convert to and from decimal strings.

By default, the goal also approves an allowance for its scheduled deposits, worked out by the SDK. The allowance covers the deposits due before it expires. It expires one day after the deadline, unless the network's longest allowed time is shorter. In that case the result has a `renewBy` date, 7 days before the allowance expires. Call `renewAllowance` before that date, or later scheduled deposits fail for lack of allowance.

```ts
import { toBaseUnits } from '@loktin/sdk';

const goal = await targetSavings.createGoal({
  target: toBaseUnits('500'),
  deadline: new Date('2027-06-30T00:00:00Z'),
  cadenceSeconds: 7 * 24 * 60 * 60,
  depositSize: toBaseUnits('20'),
  rule: { kind: 'penalty', bps: 500 },
});
console.log('New goal id:', goal.result);
if (goal.allowance?.renewBy !== undefined) {
  console.log('Renew the allowance by', goal.allowance.renewBy);
}

// Later, before `renewBy`:
await targetSavings.renewAllowance(goal.result);
```

`creationBreakdown` shows what an early withdrawal of the whole target would pay out, before the user signs. `allowanceStatus` says whether the next scheduled deposit would be short on allowance.

Goal ids are not sequential, and there is no paging by number. Use the id that `createGoal` returns. To find goals, call `userGoals(owner)` for each of your own users, at most 20 goals each, or read the contract's `goal_created` and `goal_closed` events into your own store.

## Spend & Save

`enroll` sets how much of each spend is saved: a percentage, a round-up to a unit, or both, with an optional monthly cap. `payAndSave` pays a G, M or C address and saves the skim in the same transaction. `nextWindow` returns the next withdrawal window in UTC, and `windowInTimeZone` formats it in the device's time zone, or one you name.

```ts
import { fromBaseUnits, windowInTimeZone } from '@loktin/sdk';

await spendSave.enroll({
  skim: { percentBps: 500, roundUpUnit: toBaseUnits('1') },
  monthlyCap: toBaseUnits('100'),
  destination: { kind: 'goal', goalId: goal.result },
  withdrawalDay: 15,
});

const paid = await spendSave.payAndSave(shopAddress, toBaseUnits('12.50'));
const saved = paid.result.toBalance + paid.result.toGoal;
console.log('Saved', fromBaseUnits(saved), 'USDC');

const next = windowInTimeZone(await spendSave.nextWindow());
console.log(`You can withdraw from ${next.start} until ${next.end}.`);
```

## For integrators: claiming fees

A withdrawal pays the user their share. The integrator's fee, and the early-withdrawal penalty on a Target Savings goal, accrue to the integrator in the contract. The integrator claims them with `claimFees`, and `accruedFees` shows what is owed. Loktin's fee recipient claims its fees the same way.

Claiming needs the integrator's own key: create a separate SDK instance with the integrator's address as `publicKey` and its wallet as the signer. The integrator's account also needs a trustline for the token at the time of the claim, or the payment fails and the fees stay where they are. Unclaimed fees never expire.

```ts
// The integrator's own SDK instance, with its address and its wallet.
const integratorLoktin = createLoktin({
  network: 'testnet',
  publicKey: integratorAddress,
  signer: {
    signTransaction: (xdr, opts) => integratorWallet.signTransaction(xdr, opts),
  },
});

// Fees accrue separately in each contract.
for (const savings of [
  new TargetSavings(integratorLoktin, options),
  new SpendSave(integratorLoktin, options),
]) {
  const owed = await savings.accruedFees();
  if (owed > 0n) {
    const claimed = await savings.claimFees();
    console.log('Claimed', fromBaseUnits(claimed.result), 'USDC');
  }
}
```

## For keepers

A keeper collects the scheduled deposits of Target Savings goals when they are due. Anyone may collect a due goal, and the collect can only move the due amount from the owner's wallet into the owner's goal. The keeper's account needs only XLM for fees.

`@loktin/sdk/keeper` has the parts of a keeper:

- `scanGoals` finds the goals a keeper serves: the open goals of the given integrators, from the contract's `goal_created` and `goal_closed` events, plus the open goals of an optional list of owners.
- `isDue` tells from a goal's stored data whether it can be collected now.
- `runPass` runs one pass: it scans, then collects each due goal one at a time. The contract's expected refusals, such as `NotDue` or `Shortfall`, are skips. Any other error stops the pass and is reported in `failure`.
- `feeCeilingSigner` wraps the keeper's signer so it refuses a transaction whose fee is above a ceiling. A refused collect is a skip.

```ts
import { TESTNET } from '@loktin/sdk';
import { feeCeilingSigner, runPass } from '@loktin/sdk/keeper';

// The keeper's own SDK instance, with its address and its wallet.
const keeperLoktin = createLoktin({
  network: 'testnet',
  publicKey: keeperAddress,
  signer: {
    // Refuse any transaction whose fee is above 1 XLM.
    signTransaction: feeCeilingSigner(
      (xdr, opts) => keeperWallet.signTransaction(xdr, opts),
      10_000_000n,
      TESTNET.passphrase,
    ),
  },
});

const pass = await runPass(keeperLoktin, { integrators: [integratorAddress] });
for (const result of pass.results) {
  console.log(result.goalId, result.action);
}
if (pass.failure !== undefined) {
  console.log('The pass stopped:', pass.failure.code, pass.failure.message);
}
```

## Errors

Every error the SDK throws is a `LoktinError` with a stable `code`:

| Code                     | Meaning                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_INPUT`          | An input was refused before any network call.                                                                                                  |
| `CONTRACT_ERROR`         | Target Savings or Spend & Save refused the call with one of its documented codes.                                                              |
| `TOKEN_ERROR`            | The token contract refused the call, for example for a low balance or a missing trustline.                                                     |
| `UNKNOWN_CONTRACT_ERROR` | A contract error the SDK cannot name.                                                                                                          |
| `SIGNER_REFUSED`         | The wallet refused to sign, or failed while signing.                                                                                           |
| `NETWORK`                | The RPC could not be reached, or answered with an error, after the SDK's retries: 3 for a read, and 3 for each step of a write before signing. |
| `PENDING`                | The transaction was sent and its outcome is not known yet. Look it up by hash; do not resend.                                                  |
| `TRANSACTION_FAILED`     | The transaction was sent and failed.                                                                                                           |

Each error is reported against the contract that raised it. The contract codes are listed in [docs/errors.md](https://github.com/Lokt-In/loktin-sdk/blob/main/docs/errors.md).

```ts
import { ContractError, LoktinError, PendingError } from '@loktin/sdk';

try {
  await targetSavings.deposit(goal.result, toBaseUnits('5'));
} catch (error) {
  if (error instanceof ContractError) {
    console.log(error.errorName, error.description);
  } else if (error instanceof PendingError) {
    // The outcome is not known yet. Look it up by hash; do not send again.
    console.log(error.hash, error.validUntil);
  } else if (error instanceof LoktinError) {
    console.log(error.code, error.message);
  } else {
    throw error;
  }
}
```

## What the contracts can and cannot do

- No one but the user moves the user's money. Deposits, payments and withdrawals need the user's signature, and scheduled deposits are collected only within the allowance the user approved.
- There is no yield. Savings are held as they are deposited.
- A withdrawal pays the user their share. The penalty and fees accrue to the integrator and Loktin's fee recipient, who each claim them, so no one else can block a user's withdrawal. Each is capped in the contracts:
  - the Loktin fee is 0% today, and can never be more than 1%;
  - the integrator fee is at most 1%;
  - the early-withdrawal penalty on a Target Savings goal is at most 10%.
- The upgrader role can replace the contract code. That is the one remaining trusted power over the contracts.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
