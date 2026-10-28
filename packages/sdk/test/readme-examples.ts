// The code examples in packages/sdk/README.md, kept in step with it. This
// file is type-checked by `npm run typecheck` and never run.
import type { SignTransaction } from '@stellar/stellar-sdk/contract';

// Supplied by the app.
declare const userAddress: string;
declare const integratorAddress: string;
declare const shopAddress: string;
declare const wallet: { signTransaction: SignTransaction };
declare const integratorWallet: { signTransaction: SignTransaction };
declare const keeperAddress: string;
declare const keeperWallet: { signTransaction: SignTransaction };

// README: Quick start
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
// README: end

// README: Target Savings
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
// README: end

// README: Spend & Save
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
// README: end

// README: For integrators
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
// README: end

// README: For keepers
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
// README: end

// README: Errors
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
// README: end
