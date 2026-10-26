import { Account, MuxedAccount } from '@stellar/stellar-sdk/base';
import { toBaseUnits } from '@loktin/sdk';
import { SpendSave } from '@loktin/sdk/spend-save';
import { TargetSavings } from '@loktin/sdk/target-savings';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  MIN_CADENCE,
  context,
  freshIntegrator,
  sdkFor,
  utcDay,
} from './context.js';

const ctx = context();
const user = sdkFor(ctx, 'user');
const options = { integrator: freshIntegrator(), integratorFeeBps: 50 };
const spendSave = new SpendSave(user, options);
const targetSavings = new TargetSavings(user, options);

// Ledger time cannot be moved on a real network, so a withdrawal window is
// open only when today's UTC day can be a withdrawal day.
const today = utcDay();
const windowOpen = today <= 28;
const withdrawalDay = windowOpen ? today : 1;
const skim = { percentBps: 1000, roundUpUnit: toBaseUnits('1') };
const payeeMuxed = new MuxedAccount(
  new Account(ctx.addresses.payee, '0'),
  '42',
).accountId();

describe('Spend & Save on a local network', () => {
  let goalId = 0n;

  beforeAll(async () => {
    if (!windowOpen) {
      console.log(
        `UTC day ${String(today)} cannot be a withdrawal day: the window, withdraw and close tests are skipped.`,
      );
    }
    const goal = await targetSavings.createGoal({
      target: toBaseUnits('50'),
      deadline: new Date(Date.now() + 60 * MIN_CADENCE * 1000),
      cadenceSeconds: MIN_CADENCE,
      depositSize: toBaseUnits('1'),
      rule: { kind: 'lock' },
      allowance: 'none',
    });
    goalId = goal.result;
  });

  it('enrolls with a goal destination and previews a skim', async () => {
    await spendSave.enroll({
      skim,
      destination: { kind: 'goal', goalId },
      withdrawalDay,
    });
    // 10% of 12.5, plus 0.5 to round up to a whole unit.
    await expect(spendSave.previewSkim(toBaseUnits('12.5'))).resolves.toEqual({
      spent: toBaseUnits('12.5'),
      percentPart: toBaseUnits('1.25'),
      roundUpPart: toBaseUnits('0.5'),
      skim: toBaseUnits('1.75'),
      capTrimmed: 0n,
      capped: toBaseUnits('1.75'),
    });
  });

  it('pays a G address and an M address, and saves the skims into the goal', async () => {
    const paid = await spendSave.payAndSave(
      ctx.addresses.payee,
      toBaseUnits('12.5'),
    );
    expect(paid.result).toMatchObject({
      toGoal: toBaseUnits('1.75'),
      toBalance: 0n,
      goalId,
    });
    const muxed = await spendSave.payAndSave(payeeMuxed, toBaseUnits('3'));
    expect(muxed.result).toMatchObject({ toGoal: toBaseUnits('0.3'), goalId });
    await expect(targetSavings.goal(goalId)).resolves.toMatchObject({
      principal: toBaseUnits('2.05'),
    });
  });

  it('moves the destination to the balance and saves for a spend', async () => {
    await spendSave.updateSettings({
      skim,
      destination: { kind: 'balance' },
      withdrawalDay,
    });
    const saved = await spendSave.saveForSpend(toBaseUnits('10'));
    expect(saved.result).toMatchObject({
      toBalance: toBaseUnits('1'),
      toGoal: 0n,
      goalId: undefined,
    });
    await expect(spendSave.enrollment()).resolves.toMatchObject({
      principal: toBaseUnits('1'),
      destination: { kind: 'balance' },
      withdrawalDay,
      effectiveWithdrawalDay: withdrawalDay,
      totalSpent: toBaseUnits('25.5'),
    });
  });

  it.skipIf(!windowOpen)('reports the window open today', async () => {
    const start = new Date(
      Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        withdrawalDay,
      ),
    );
    await expect(spendSave.nextWindow()).resolves.toEqual({
      start,
      end: new Date(start.getTime() + 86_400_000),
    });
  });

  it.skipIf(!windowOpen)(
    'withdraws inside the window, then closes the empty enrolment',
    async () => {
      // 0.5% integrator fee and 1% Loktin fee on 1.
      const withdrawn = await spendSave.withdraw(toBaseUnits('1'));
      expect(withdrawn.result).toEqual({
        amount: toBaseUnits('1'),
        integratorFee: toBaseUnits('0.005'),
        loktinFee: toBaseUnits('0.01'),
        toUser: toBaseUnits('0.985'),
      });
      await spendSave.close();
      await expect(spendSave.enrollment()).rejects.toMatchObject({
        code: 'CONTRACT_ERROR',
        errorName: 'EnrollmentNotFound',
      });
    },
  );
});
