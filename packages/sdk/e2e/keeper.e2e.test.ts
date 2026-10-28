// The keeper core (E1, W97) on the local network: a goal is not due before
// its first period, a fee above the ceiling is skipped, a due goal is
// collected once, and a second pass in the same period finds it not due.
import { Keypair } from '@stellar/stellar-sdk/base';
import { basicNodeSigner } from '@stellar/stellar-sdk/contract';
import { createLoktin, toBaseUnits } from '@loktin/sdk';
import { feeCeilingSigner, runPass } from '@loktin/sdk/keeper';
import { TargetSavings } from '@loktin/sdk/target-savings';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  MIN_CADENCE,
  PASSPHRASE,
  context,
  freshIntegrator,
  network,
  sdkFor,
  sleep,
} from './context.js';

const ctx = context();
const user = sdkFor(ctx, 'user');
// A fresh integrator, so the keeper serves this file's goal only.
const integrator = freshIntegrator();
const savings = new TargetSavings(user, { integrator, integratorFeeBps: 0 });
// The keeper signs with the setup's integrator account, which holds XLM.
const keeperKey = Keypair.fromSecret(ctx.secrets.integrator);

function keeper(maxFeeStroops: bigint) {
  return createLoktin({
    network: network(ctx),
    publicKey: keeperKey.publicKey(),
    signer: {
      signTransaction: feeCeilingSigner(
        basicNodeSigner(keeperKey, PASSPHRASE).signTransaction,
        maxFeeStroops,
        PASSPHRASE,
      ),
    },
  });
}
const pass = (maxFeeStroops = 10_000_000n) =>
  runPass(keeper(maxFeeStroops), { integrators: [integrator] });
const balance = () =>
  user.read<bigint>('token', 'balance', { id: ctx.addresses.user });

describe('the keeper on a local network', () => {
  let goalId = 0n;

  beforeAll(async () => {
    const created = await savings.createGoal({
      target: toBaseUnits('10'),
      deadline: new Date(Date.now() + 10 * MIN_CADENCE * 1000),
      cadenceSeconds: MIN_CADENCE,
      depositSize: toBaseUnits('1'),
      rule: { kind: 'lock' },
    });
    goalId = created.result;
  });

  it('finds the goal not due before its first period', async () => {
    const result = await pass();
    expect(result.failure).toBeUndefined();
    expect(result.results).toEqual([{ goalId, action: 'not-due' }]);
    expect(result.scan.pages).toBeGreaterThanOrEqual(1);
  });

  it('skips a due goal whose fee is above the ceiling', async () => {
    const { start } = await savings.goal(goalId);
    const due = start.getTime() + MIN_CADENCE * 1000;
    await sleep(Math.max(0, due - Date.now()) + 6000);
    const result = await pass(1n);
    expect(result.results).toEqual([
      { goalId, action: 'skipped', reason: 'FeeAboveCeiling' },
    ]);
    await expect(savings.goal(goalId)).resolves.toMatchObject({
      principal: 0n,
      lastCollectedPeriod: 0n,
    });
  });

  it('collects the due goal, moving the balance and principal by the deposit', async () => {
    const before = await balance();
    const result = await pass();
    expect(result.failure).toBeUndefined();
    expect(result.results).toEqual([
      expect.objectContaining({
        goalId,
        action: 'collected',
        amount: toBaseUnits('1'),
      }),
    ]);
    expect(before - (await balance())).toBe(toBaseUnits('1'));
    await expect(savings.goal(goalId)).resolves.toMatchObject({
      principal: toBaseUnits('1'),
      lastCollectedPeriod: 1n,
    });
  });

  it('finds the goal not due again in the same period', async () => {
    // The goal's stored data shows the period is collected, so the pass
    // does not send a collect that AlreadyCollected would refuse.
    const result = await pass();
    expect(result.results).toEqual([{ goalId, action: 'not-due' }]);
    await expect(savings.goal(goalId)).resolves.toMatchObject({
      principal: toBaseUnits('1'),
    });
  });
});
