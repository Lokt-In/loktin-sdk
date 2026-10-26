import { Address, StrKey, nativeToScVal } from '@stellar/stellar-sdk/base';
import { ScMapEntry, ScVal } from '@stellar/stellar-sdk/xdr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContractError, InvalidInputError, TESTNET } from '../src/index.js';
import {
  type EnrollInput,
  type Enrollment,
  SpendSave,
} from '../src/spend-save/index.js';
import type { RawEnrollment } from '../src/spend-save/types.js';
import {
  FakeServer,
  USER,
  callEvent,
  errorEvent,
  simulationFailure,
  simulationSuccess,
} from './fake-server.js';
import { loktinOn, queueWrite, retvalOf, settle, xdrOf } from './modules.js';

const SS = TESTNET.contracts.spendSave;
const TS = TESTNET.contracts.targetSavings;
const USDC = TESTNET.token;
const INTEGRATOR = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(3));
const OPTIONS = { integrator: INTEGRATOR, integratorFeeBps: 50 };
const PAYEE_G = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(5));
const PAYEE_M = StrKey.encodeMed25519PublicKey(
  new Uint8Array([...new Uint8Array(32).fill(5), 0, 0, 0, 0, 0, 0, 0, 42]),
);
const PAYEE_C = StrKey.encodeContract(new Uint8Array(32).fill(6));
// 2026-11 and 2026-12 as month indexes: year × 12 + (month − 1).
const NOV_2026 = 2026 * 12 + 10;
const DEC_2026 = NOV_2026 + 1;
const NOW = new Date(Date.UTC(2026, 10, 15));

const RAW_ENROLLMENT: RawEnrollment = {
  user: USER,
  integrator: INTEGRATOR,
  integrator_fee_bps: 50,
  loktin_fee_bps: 25,
  skim: { percent_bps: 500, round_up_unit: null },
  monthly_cap: 10_000n,
  destination: { tag: 'Goal', values: [4n] },
  withdrawal_day: 5,
  pending_day: { tag: 'Pending', values: [20, DEC_2026] },
  principal: 300n,
  shares: 300n,
  month_index: NOV_2026,
  saved_this_month: 40n,
  total_spent: 800n,
  total_saved: 40n,
};

const ENROLLMENT: Enrollment = {
  user: USER,
  integrator: INTEGRATOR,
  integratorFeeBps: 50,
  loktinFeeBps: 25,
  skim: { percentBps: 500, roundUpUnit: undefined },
  monthlyCap: 10_000n,
  destination: { kind: 'goal', goalId: 4n },
  withdrawalDay: 5,
  pendingDay: { day: 20, fromMonth: DEC_2026 },
  principal: 300n,
  shares: 300n,
  monthIndex: NOV_2026,
  savedThisMonth: 40n,
  totalSpent: 800n,
  totalSaved: 40n,
};

const RAW_SAVING = {
  skim: 50n,
  cap_trimmed: 0n,
  shortfall: 0n,
  to_balance: 20n,
  to_goal: 30n,
  goal_id: 4n,
};
const SAVING = {
  skim: 50n,
  capTrimmed: 0n,
  shortfall: 0n,
  toBalance: 20n,
  toGoal: 30n,
  goalId: 4n,
};
const RAW_WITHDRAWAL = {
  amount: 100n,
  loktin_fee: 0n,
  integrator_fee: 0n,
  to_user: 100n,
};
const WITHDRAWAL = {
  amount: 100n,
  loktinFee: 0n,
  integratorFee: 0n,
  toUser: 100n,
};

const SETTINGS: EnrollInput = {
  skim: { percentBps: 500, roundUpUnit: 100n },
  monthlyCap: 10_000n,
  destination: { kind: 'goal', goalId: 4n },
  withdrawalDay: 5,
};

const i128 = (value: bigint) => nativeToScVal(value, { type: 'i128' });
const address = (value: string) => new Address(value).toScVal();
const SETTINGS_XDR = [
  ScVal.scvMap([
    new ScMapEntry({
      key: ScVal.scvSymbol('percent_bps'),
      val: ScVal.scvU32(500),
    }),
    new ScMapEntry({ key: ScVal.scvSymbol('round_up_unit'), val: i128(100n) }),
  ]),
  i128(10_000n),
  ScVal.scvVec([ScVal.scvSymbol('Goal'), ScVal.scvU64(4n)]),
  ScVal.scvU32(5),
];

let server: FakeServer;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  server = new FakeServer();
});

afterEach(() => {
  vi.useRealTimers();
});

function module(): SpendSave {
  return new SpendSave(loktinOn(server), OPTIONS);
}

describe('Spend & Save writes', () => {
  it('enroll encodes every argument', async () => {
    queueWrite(server, ScVal.scvVoid());
    await expect(settle(module().enroll(SETTINGS))).resolves.toMatchObject({
      result: null,
    });
    const [call] = server.invocations();
    expect(call?.contractId).toBe(SS);
    expect(call?.method).toBe('enroll');
    expect(xdrOf(call?.args ?? [])).toEqual(
      xdrOf([
        address(USER),
        address(INTEGRATOR),
        ScVal.scvU32(50),
        ...SETTINGS_XDR,
      ]),
    );
  });

  it('enroll leaves out the cap and percentage as empty options', async () => {
    queueWrite(server, ScVal.scvVoid());
    await settle(
      module().enroll({
        skim: { roundUpUnit: 100n },
        destination: { kind: 'balance' },
        withdrawalDay: 28,
      }),
    );
    const [call] = server.invocations();
    expect(xdrOf(call?.args.slice(3) ?? [])).toEqual(
      xdrOf([
        ScVal.scvMap([
          new ScMapEntry({
            key: ScVal.scvSymbol('percent_bps'),
            val: ScVal.scvVoid(),
          }),
          new ScMapEntry({
            key: ScVal.scvSymbol('round_up_unit'),
            val: i128(100n),
          }),
        ]),
        ScVal.scvVoid(),
        ScVal.scvVec([ScVal.scvSymbol('Balance')]),
        ScVal.scvU32(28),
      ]),
    );
  });

  it('updateSettings sends the same settings, without a fee', async () => {
    queueWrite(server, ScVal.scvVoid());
    await settle(module().updateSettings(SETTINGS));
    const [call] = server.invocations();
    expect(call?.method).toBe('update_settings');
    expect(xdrOf(call?.args ?? [])).toEqual(
      xdrOf([address(USER), address(INTEGRATOR), ...SETTINGS_XDR]),
    );
  });

  it.each([
    ['an account', PAYEE_G, 'scAddressTypeAccount'],
    ['a muxed account', PAYEE_M, 'scAddressTypeMuxedAccount'],
    ['a contract', PAYEE_C, 'scAddressTypeContract'],
  ])('payAndSave pays %s and decodes the saving', async (_, to, type) => {
    queueWrite(server, retvalOf('spend-save', 'pay_and_save', RAW_SAVING));
    await expect(settle(module().payAndSave(to, 1000n))).resolves.toMatchObject(
      {
        result: SAVING,
      },
    );
    const [call] = server.invocations();
    expect(call?.method).toBe('pay_and_save');
    expect(xdrOf(call?.args ?? [])).toEqual(
      xdrOf([address(USER), address(INTEGRATOR), address(to), i128(1000n)]),
    );
    const payee = call?.args[2];
    expect(payee?.type === 'scvAddress' && payee.address.type).toBe(type);
  });

  it('saveForSpend, withdraw and close call their functions for publicKey', async () => {
    // The fake repeats its last answer, so all three are queued first.
    queueWrite(server, retvalOf('spend-save', 'save_for_spend', RAW_SAVING));
    queueWrite(server, retvalOf('spend-save', 'withdraw', RAW_WITHDRAWAL));
    queueWrite(server, ScVal.scvVoid());
    await expect(settle(module().saveForSpend(1000n))).resolves.toMatchObject({
      result: SAVING,
    });
    await expect(settle(module().withdraw(100n))).resolves.toMatchObject({
      result: WITHDRAWAL,
    });
    await expect(settle(module().close())).resolves.toMatchObject({
      result: null,
    });
    const calls = server.invocations();
    expect(calls.map((call) => call.method)).toEqual([
      'save_for_spend',
      'withdraw',
      'close',
    ]);
    expect(xdrOf(calls[0]?.args ?? [])).toEqual(
      xdrOf([address(USER), address(INTEGRATOR), i128(1000n)]),
    );
    expect(xdrOf(calls[1]?.args ?? [])).toEqual(
      xdrOf([address(USER), address(INTEGRATOR), i128(100n)]),
    );
    expect(xdrOf(calls[2]?.args ?? [])).toEqual(
      xdrOf([address(USER), address(INTEGRATOR)]),
    );
  });
});

describe('Spend & Save reads', () => {
  it('decode the enrolment, with the withdrawal day that applies now', async () => {
    server.simulateBy = () =>
      simulationSuccess(retvalOf('spend-save', 'enrollment', RAW_ENROLLMENT));
    const spendSave = module();
    await expect(spendSave.enrollment()).resolves.toEqual({
      ...ENROLLMENT,
      effectiveWithdrawalDay: 5,
    });
    // The pending day applies from December, by the device clock in UTC.
    vi.setSystemTime(new Date(Date.UTC(2026, 11, 1)));
    await expect(spendSave.enrollment()).resolves.toMatchObject({
      withdrawalDay: 5,
      effectiveWithdrawalDay: 20,
    });
    const [call] = server.invocations();
    expect(call?.method).toBe('enrollment');
    expect(xdrOf(call?.args ?? [])).toEqual(
      xdrOf([address(USER), address(INTEGRATOR)]),
    );
  });

  it('read previews, the window and the settings, one call each', async () => {
    const start = Date.UTC(2026, 11, 20) / 1000;
    const answers: Record<string, ScVal> = {
      preview_skim: retvalOf('spend-save', 'preview_skim', {
        spent: 1003n,
        percent_part: 50n,
        round_up_part: 97n,
        skim: 147n,
        cap_trimmed: 7n,
        capped: 140n,
      }),
      preview_withdraw: retvalOf(
        'spend-save',
        'preview_withdraw',
        RAW_WITHDRAWAL,
      ),
      next_window: retvalOf('spend-save', 'next_window', [
        BigInt(start),
        BigInt(start + 86_400),
      ]),
      target_savings: address(TS),
      token: address(USDC),
      loktin_fee_bps: ScVal.scvU32(25),
      fee_recipient: address(INTEGRATOR),
      paused: ScVal.scvBool(true),
    };
    server.simulateBy = (call) => {
      const retval = answers[call.method];
      return retval === undefined ? undefined : simulationSuccess(retval);
    };
    const spendSave = module();
    await expect(spendSave.previewSkim(1003n)).resolves.toEqual({
      spent: 1003n,
      percentPart: 50n,
      roundUpPart: 97n,
      skim: 147n,
      capTrimmed: 7n,
      capped: 140n,
    });
    await expect(spendSave.previewWithdraw(100n)).resolves.toEqual(WITHDRAWAL);
    await expect(spendSave.nextWindow()).resolves.toEqual({
      start: new Date(start * 1000),
      end: new Date((start + 86_400) * 1000),
    });
    await expect(spendSave.targetSavings()).resolves.toBe(TS);
    await expect(spendSave.token()).resolves.toBe(USDC);
    await expect(spendSave.loktinFeeBps()).resolves.toBe(25);
    await expect(spendSave.feeRecipient()).resolves.toBe(INTEGRATOR);
    await expect(spendSave.paused()).resolves.toBe(true);
    expect(server.methods()).toEqual(Array(8).fill('simulateTransaction'));
    const calls = server.invocations();
    expect(calls.map((call) => call.method)).toEqual(Object.keys(answers));
    expect(xdrOf(calls[0]?.args ?? [])).toEqual(
      xdrOf([address(USER), address(INTEGRATOR), i128(1003n)]),
    );
  });

  it('read an empty Target Savings option as undefined', async () => {
    server.simulateBy = () => simulationSuccess(ScVal.scvVoid());
    await expect(module().targetSavings()).resolves.toBeUndefined();
  });

  it('use the read adapter for the reads it has, and the chain for the rest', async () => {
    const enrollment = vi.fn(() => Promise.resolve(ENROLLMENT));
    server.simulateBy = () => simulationSuccess(ScVal.scvBool(false));
    const spendSave = new SpendSave(
      loktinOn(server, { spendSave: { enrollment } }),
      OPTIONS,
    );
    await expect(spendSave.enrollment()).resolves.toMatchObject({
      effectiveWithdrawalDay: 5,
    });
    expect(enrollment).toHaveBeenCalledWith(USER, INTEGRATOR);
    expect(server.calls).toEqual([]);
    await expect(spendSave.paused()).resolves.toBe(false);
    expect(server.invocations().map((call) => call.method)).toEqual(['paused']);
  });
});

describe('Spend & Save checks before any network call', () => {
  async function refused(
    call: () => Promise<unknown>,
    errorName: string,
  ): Promise<void> {
    const error = await call().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidInputError);
    expect((error as Error).message).toContain(errorName);
    expect(server.calls).toEqual([]);
  }

  it.each(['enroll', 'updateSettings'] as const)(
    'refuse each %s setting the contract would refuse',
    async (method) => {
      const spendSave = module();
      const call = (change: Partial<EnrollInput>) => () =>
        spendSave[method]({ ...SETTINGS, ...change });
      await refused(call({ skim: { percentBps: 99 } }), 'InvalidSkim');
      await refused(call({ skim: { percentBps: 5001 } }), 'InvalidSkim');
      await refused(call({ skim: { roundUpUnit: 0n } }), 'InvalidSkim');
      await refused(call({ skim: {} }), 'InvalidSkim');
      await refused(call({ monthlyCap: 0n }), 'InvalidCap');
      await refused(call({ withdrawalDay: 0 }), 'InvalidDay');
      await refused(call({ withdrawalDay: 29 }), 'InvalidDay');
    },
  );

  it('refuse an integrator fee above 100 or the contract as integrator, when the module is created', () => {
    const loktin = loktinOn(server);
    expect(
      () => new SpendSave(loktin, { ...OPTIONS, integratorFeeBps: 101 }),
    ).toThrow(/RateAboveCap/);
    expect(() => new SpendSave(loktin, { ...OPTIONS, integrator: SS })).toThrow(
      /InvalidIntegrator/,
    );
    expect(server.calls).toEqual([]);
  });

  it('refuse amounts that are not above zero, and Spend & Save as the payee', async () => {
    await refused(() => module().payAndSave(PAYEE_G, 0n), 'InvalidAmount');
    await refused(() => module().payAndSave(SS, 10n), 'InvalidPayee');
    await refused(() => module().saveForSpend(0n), 'InvalidAmount');
    await refused(() => module().withdraw(0n), 'InvalidAmount');
  });
});

describe('accrued fees', () => {
  const RECIPIENT = StrKey.encodeContract(new Uint8Array(32).fill(6));

  it('claimFees claims for publicKey and decodes the amount', async () => {
    queueWrite(server, retvalOf('spend-save', 'claim_fees', 550n));
    const claimed = await settle(module().claimFees());
    expect(claimed).toMatchObject({ result: 550n });
    expect((claimed as { result: unknown }).result).toBeTypeOf('bigint');
    const [call] = server.invocations();
    expect(call?.contractId).toBe(SS);
    expect(call?.method).toBe('claim_fees');
    expect(xdrOf(call?.args ?? [])).toEqual(xdrOf([address(USER)]));
  });

  it('maps NothingToClaim to CONTRACT_ERROR 215', async () => {
    server.simulations.push(
      simulationFailure('HostError: Error(Contract, #215)', [
        callEvent(SS),
        errorEvent(SS, 215),
      ]),
    );
    const error = await settle(module().claimFees());
    expect(error).toBeInstanceOf(ContractError);
    expect(error).toMatchObject({
      code: 'CONTRACT_ERROR',
      contract: 'spend-save',
      number: 215,
      errorName: 'NothingToClaim',
      description: 'The recipient has no accrued fees to claim.',
    });
    expect(server.methods()).not.toContain('sendTransaction');
  });

  it('accruedFees reads for the integrator by default, or for a given recipient', async () => {
    server.simulateBy = (call) =>
      call.method === 'accrued_fees' ? simulationSuccess(i128(75n)) : undefined;
    const spendSave = module();
    await expect(spendSave.accruedFees()).resolves.toBe(75n);
    await expect(spendSave.accruedFees(RECIPIENT)).resolves.toBe(75n);
    const calls = server.invocations();
    expect(calls.map((call) => call.method)).toEqual([
      'accrued_fees',
      'accrued_fees',
    ]);
    expect(xdrOf(calls[0]?.args ?? [])).toEqual(xdrOf([address(INTEGRATOR)]));
    expect(xdrOf(calls[1]?.args ?? [])).toEqual(xdrOf([address(RECIPIENT)]));
  });

  it('accruedFees refuses an invalid recipient before any server call', async () => {
    for (const recipient of ['G', 'not an address', PAYEE_M]) {
      await expect(module().accruedFees(recipient)).rejects.toThrow(
        InvalidInputError,
      );
    }
    expect(server.calls).toEqual([]);
  });

  it('accruedFees uses the read adapter when it has the method', async () => {
    const accruedFees = vi.fn(() => Promise.resolve(12n));
    const spendSave = new SpendSave(
      loktinOn(server, { spendSave: { accruedFees } }),
      OPTIONS,
    );
    await expect(spendSave.accruedFees()).resolves.toBe(12n);
    expect(accruedFees).toHaveBeenCalledWith(INTEGRATOR);
    expect(server.calls).toEqual([]);
  });

  it('claimFees never uses the read adapter', async () => {
    const accruedFees = vi.fn(() => Promise.resolve(12n));
    queueWrite(server, retvalOf('spend-save', 'claim_fees', 5n));
    const spendSave = new SpendSave(
      loktinOn(server, { spendSave: { accruedFees } }),
      OPTIONS,
    );
    await settle(spendSave.claimFees());
    expect(accruedFees).not.toHaveBeenCalled();
    expect(server.invocations().map((call) => call.method)).toEqual([
      'claim_fees',
    ]);
  });
});
