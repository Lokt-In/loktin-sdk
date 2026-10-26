// Errors are reported against the contract that raised them: a handled
// GoalNotFound from the closed destination goal must not hide the token's
// TrustlineMissing.
import { toBaseUnits } from '@loktin/sdk';
import { SpendSave } from '@loktin/sdk/spend-save';
import { TargetSavings } from '@loktin/sdk/target-savings';
import { beforeAll, describe, expect, it } from 'vitest';
import { MIN_CADENCE, context, freshIntegrator, sdkFor } from './context.js';

const ctx = context();
const user = sdkFor(ctx, 'user');
const options = { integrator: freshIntegrator(), integratorFeeBps: 0 };
const spendSave = new SpendSave(user, options);
const targetSavings = new TargetSavings(user, options);

describe('error origin with a closed destination goal', () => {
  beforeAll(async () => {
    const goal = await targetSavings.createGoal({
      target: toBaseUnits('50'),
      deadline: new Date(Date.now() + 60 * MIN_CADENCE * 1000),
      cadenceSeconds: MIN_CADENCE,
      depositSize: toBaseUnits('1'),
      rule: { kind: 'lock' },
      allowance: 'none',
    });
    await spendSave.enroll({
      skim: { percentBps: 1000 },
      destination: { kind: 'goal', goalId: goal.result },
      withdrawalDay: 1,
    });
    // An empty goal closes at once, even under the lock rule.
    await targetSavings.withdraw(goal.result);
  });

  it('reports a payment to an account with no trustline as TOKEN_ERROR 13', async () => {
    await expect(
      spendSave.payAndSave(ctx.addresses.payee2, toBaseUnits('10')),
    ).rejects.toMatchObject({
      code: 'TOKEN_ERROR',
      contractId: ctx.token,
      number: 13,
      errorName: 'TrustlineMissing',
    });
  });

  it('saves a skim aimed at the closed goal to the balance', async () => {
    const saved = await spendSave.saveForSpend(toBaseUnits('10'));
    expect(saved.result).toMatchObject({
      skim: toBaseUnits('1'),
      toBalance: toBaseUnits('1'),
      toGoal: 0n,
      goalId: undefined,
    });
  });
});
