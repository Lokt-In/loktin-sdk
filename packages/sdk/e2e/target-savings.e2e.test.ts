import { toBaseUnits } from '@loktin/sdk';
import { TargetSavings } from '@loktin/sdk/target-savings';
import { describe, expect, it } from 'vitest';
import {
  MIN_CADENCE,
  context,
  freshIntegrator,
  sdkFor,
  sleep,
} from './context.js';

const ctx = context();
const targetSavings = new TargetSavings(sdkFor(ctx, 'user'), {
  integrator: freshIntegrator(),
  integratorFeeBps: 50,
});

describe('Target Savings on a local network', () => {
  let goalId = 0n;
  // The owner's whole allowance after createGoal: it covers every open goal.
  let approved = 0n;

  it('createGoal approves the automatic allowance', async () => {
    // Other files' goals of the same user share the allowance (W116).
    const others = await targetSavings.userGoals();
    const created = await targetSavings.createGoal({
      target: toBaseUnits('100'),
      deadline: new Date(Date.now() + 10 * MIN_CADENCE * 1000),
      cadenceSeconds: MIN_CADENCE,
      depositSize: toBaseUnits('10'),
      rule: { kind: 'penalty', bps: 500 },
    });
    goalId = created.result;
    // Ten periods of 10 before the deadline, which is the whole target,
    // plus what the owner's other open goals still need.
    approved = created.allowance?.amount ?? 0n;
    if (others.length === 0) {
      expect(created.allowance).toMatchObject({
        amount: toBaseUnits('100'),
        periods: 10n,
      });
    } else {
      expect(approved).toBeGreaterThanOrEqual(toBaseUnits('100'));
      expect(created.allowance?.periods).toBeGreaterThanOrEqual(10n);
    }
    await expect(targetSavings.allowanceStatus(goalId)).resolves.toEqual({
      allowance: approved,
      nextAmount: toBaseUnits('10'),
      short: false,
    });
  });

  it('deposit adds to the principal', async () => {
    await targetSavings.deposit(goalId, toBaseUnits('5'));
    await expect(targetSavings.goal(goalId)).resolves.toMatchObject({
      principal: toBaseUnits('5'),
    });
  });

  it('refuses a deposit above what the goal needs, and a collection before period 1', async () => {
    await expect(
      targetSavings.deposit(goalId, toBaseUnits('96')),
    ).rejects.toMatchObject({
      code: 'CONTRACT_ERROR',
      contract: 'target-savings',
      errorName: 'ExceedsTarget',
    });
    await expect(targetSavings.collect(goalId)).rejects.toMatchObject({
      code: 'CONTRACT_ERROR',
      errorName: 'NotDue',
    });
  });

  it('collects period 1 once it is due, and only once', async () => {
    const { start } = await targetSavings.goal(goalId);
    // Ledger time follows the clock, so wait for period 1 plus a margin.
    const due = start.getTime() + MIN_CADENCE * 1000;
    await sleep(Math.max(0, due - Date.now()) + 5000);
    await targetSavings.collect(goalId);
    await expect(targetSavings.goal(goalId)).resolves.toMatchObject({
      principal: toBaseUnits('15'),
      lastCollectedPeriod: 1n,
    });
    await expect(targetSavings.collect(goalId)).rejects.toMatchObject({
      code: 'CONTRACT_ERROR',
      errorName: 'AlreadyCollected',
    });
  });

  it('previews the withdrawal, reports the allowance and renews it', async () => {
    // 15 withdrawn early: 5% penalty, 0.5% integrator fee, 1% Loktin fee.
    await expect(targetSavings.previewWithdraw(goalId)).resolves.toEqual({
      amount: toBaseUnits('15'),
      penalty: toBaseUnits('0.75'),
      integratorFee: toBaseUnits('0.075'),
      loktinFee: toBaseUnits('0.15'),
      toUser: toBaseUnits('14.025'),
    });
    // The collect of period 1 took 10 from the shared allowance.
    await expect(targetSavings.allowanceStatus(goalId)).resolves.toEqual({
      allowance: approved - toBaseUnits('10'),
      nextAmount: toBaseUnits('10'),
      short: false,
    });
    // The renewal covers every open goal of the owner, this one's 85 among
    // them at most.
    const renewed = await targetSavings.renewAllowance(goalId);
    expect(renewed.allowance.amount).toBeGreaterThan(0n);
    expect(renewed.allowance.amount).toBeLessThanOrEqual(approved);
    await expect(targetSavings.allowanceStatus(goalId)).resolves.toMatchObject({
      allowance: renewed.allowance.amount,
    });
  });
});
