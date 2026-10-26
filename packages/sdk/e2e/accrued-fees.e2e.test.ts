// DoS.6: an integrator with no trustline for the token cannot block a
// user's withdrawal. Its fees accrue, and it claims them once it can
// receive the token.
import { toBaseUnits } from '@loktin/sdk';
import { SpendSave } from '@loktin/sdk/spend-save';
import { TargetSavings } from '@loktin/sdk/target-savings';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  MIN_CADENCE,
  NETWORK,
  context,
  sdkFor,
  stellar,
  utcDay,
} from './context.js';

const ctx = context();
const user = sdkFor(ctx, 'user');
const integrator = sdkFor(ctx, 'integrator');
const options = { integrator: ctx.addresses.integrator, integratorFeeBps: 100 };
const feeRecipient = ctx.addresses['fee-recipient'];
const windowOpen = utcDay() <= 28;

// The user's modules, and the integrator's own, which claim for it.
const userSavings = new TargetSavings(user, options);
const userSpendSave = new SpendSave(user, options);
const integratorSavings = new TargetSavings(integrator, options);
const integratorSpendSave = new SpendSave(integrator, options);

const trustlineMissing = {
  code: 'TOKEN_ERROR',
  contractId: ctx.token,
  number: 13,
  errorName: 'TrustlineMissing',
};

describe('accrued fees with an integrator that has no trustline', () => {
  beforeAll(() => {
    if (!windowOpen) {
      console.log(
        `UTC day ${String(utcDay())} cannot be a withdrawal day: the Spend & Save withdrawal and claim are skipped.`,
      );
    }
  });

  it('a Target Savings withdrawal pays the user and accrues the fees', async () => {
    const goal = await userSavings.createGoal({
      target: toBaseUnits('100'),
      deadline: new Date(Date.now() + 10 * MIN_CADENCE * 1000),
      cadenceSeconds: MIN_CADENCE,
      depositSize: toBaseUnits('10'),
      rule: { kind: 'penalty', bps: 1000 },
      allowance: 'none',
    });
    await userSavings.deposit(goal.result, toBaseUnits('10'));
    const withdrawn = await userSavings.withdraw(goal.result);
    expect(withdrawn.result).toEqual({
      amount: toBaseUnits('10'),
      penalty: toBaseUnits('1'),
      integratorFee: toBaseUnits('0.1'),
      loktinFee: toBaseUnits('0.1'),
      toUser: toBaseUnits('8.8'),
    });
    await expect(userSavings.accruedFees()).resolves.toBe(toBaseUnits('1.1'));
    await expect(userSavings.accruedFees(feeRecipient)).resolves.toBe(
      toBaseUnits('0.1'),
    );
  });

  it.skipIf(!windowOpen)(
    'a Spend & Save withdrawal pays the user and accrues the fees',
    async () => {
      await userSpendSave.enroll({
        skim: { percentBps: 1000 },
        destination: { kind: 'balance' },
        withdrawalDay: utcDay(),
      });
      await userSpendSave.saveForSpend(toBaseUnits('100'));
      const withdrawn = await userSpendSave.withdraw(toBaseUnits('10'));
      expect(withdrawn.result).toEqual({
        amount: toBaseUnits('10'),
        integratorFee: toBaseUnits('0.1'),
        loktinFee: toBaseUnits('0.1'),
        toUser: toBaseUnits('9.8'),
      });
      await expect(userSpendSave.accruedFees()).resolves.toBe(
        toBaseUnits('0.1'),
      );
      await expect(userSpendSave.accruedFees(feeRecipient)).resolves.toBe(
        toBaseUnits('0.1'),
      );
    },
  );

  it('a claim without a trustline fails with TOKEN_ERROR 13, and the fees stay', async () => {
    await expect(integratorSavings.claimFees()).rejects.toMatchObject(
      trustlineMissing,
    );
    await expect(integratorSavings.accruedFees()).resolves.toBe(
      toBaseUnits('1.1'),
    );
    if (windowOpen) {
      await expect(integratorSpendSave.claimFees()).rejects.toMatchObject(
        trustlineMissing,
      );
    }
  });

  it('after a trustline is added, the claim pays out once', async () => {
    await stellar(ctx.configDir, [
      'tx',
      'new',
      'change-trust',
      '--line',
      ctx.asset,
      '--source-account',
      'integrator',
      '--network',
      NETWORK,
    ]);
    const claimed = await integratorSavings.claimFees();
    expect(claimed.result).toBe(toBaseUnits('1.1'));
    await expect(integratorSavings.accruedFees()).resolves.toBe(0n);
    await expect(integratorSavings.claimFees()).rejects.toMatchObject({
      code: 'CONTRACT_ERROR',
      contract: 'target-savings',
      errorName: 'NothingToClaim',
    });
    if (windowOpen) {
      const fromSpendSave = await integratorSpendSave.claimFees();
      expect(fromSpendSave.result).toBe(toBaseUnits('0.1'));
      await expect(integratorSpendSave.claimFees()).rejects.toMatchObject({
        code: 'CONTRACT_ERROR',
        contract: 'spend-save',
        errorName: 'NothingToClaim',
      });
    }
  });
});
