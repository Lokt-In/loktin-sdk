// C4: pause blocks new goals, and never blocks a withdrawal or a claim.
import { toBaseUnits } from '@loktin/sdk';
import {
  type CreateGoalInput,
  TargetSavings,
} from '@loktin/sdk/target-savings';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIN_CADENCE, NETWORK, context, sdkFor, stellar } from './context.js';

const ctx = context();
const user = sdkFor(ctx, 'user');
// The user is its own integrator here, so the user can claim the fees.
const targetSavings = new TargetSavings(user, {
  integrator: ctx.addresses.user,
  integratorFeeBps: 100,
});

function goal(): CreateGoalInput {
  return {
    target: toBaseUnits('100'),
    deadline: new Date(Date.now() + 10 * MIN_CADENCE * 1000),
    cadenceSeconds: MIN_CADENCE,
    depositSize: toBaseUnits('10'),
    rule: { kind: 'penalty', bps: 1000 },
    allowance: 'none',
  };
}

// The pauser signs through the CLI, with its throwaway key.
function setPaused(paused: boolean): Promise<string> {
  return stellar(ctx.configDir, [
    'contract',
    'invoke',
    '--id',
    ctx.targetSavings,
    '--source-account',
    'pauser',
    '--network',
    NETWORK,
    '--',
    paused ? 'pause' : 'unpause',
    '--caller',
    ctx.addresses.pauser,
  ]);
}

describe('pause on a local network', () => {
  let goalId = 0n;

  beforeAll(async () => {
    const created = await targetSavings.createGoal(goal());
    goalId = created.result;
    await targetSavings.deposit(goalId, toBaseUnits('10'));
    await setPaused(true);
  });

  afterAll(async () => {
    await setPaused(false);
  });

  it('refuses a new goal with EnforcedPause', async () => {
    await expect(targetSavings.paused()).resolves.toBe(true);
    await expect(targetSavings.createGoal(goal())).rejects.toMatchObject({
      code: 'CONTRACT_ERROR',
      contract: 'target-savings',
      number: 1000,
      errorName: 'EnforcedPause',
    });
  });

  it('still lets the owner withdraw and the integrator claim', async () => {
    const withdrawn = await targetSavings.withdraw(goalId);
    expect(withdrawn.result.toUser).toBe(toBaseUnits('8.8'));
    const claimed = await targetSavings.claimFees();
    expect(claimed.result).toBe(toBaseUnits('1.1'));
  });
});
