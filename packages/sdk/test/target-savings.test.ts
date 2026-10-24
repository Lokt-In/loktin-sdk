import { Address, StrKey, nativeToScVal } from '@stellar/stellar-sdk/base';
import { ScVal } from '@stellar/stellar-sdk/xdr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInputError, TESTNET } from '../src/index.js';
import {
  type CreateGoalInput,
  type Goal,
  TargetSavings,
} from '../src/target-savings/index.js';
import type { RawGoal } from '../src/target-savings/types.js';
import { FakeServer, USER, simulationSuccess } from './fake-server.js';
import { loktinOn, queueWrite, retvalOf, settle, xdrOf } from './modules.js';

const TS = TESTNET.contracts.targetSavings;
const USDC = TESTNET.token;
const INTEGRATOR = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(3));
const OPTIONS = { integrator: INTEGRATOR, integratorFeeBps: 50 };
const NOW = new Date(Date.UTC(2026, 10, 1));
const NOW_S = NOW.getTime() / 1000;
const WEEK = 604_800;
// Two and a half weeks in: period 2 is current and was collected.
const START_S = NOW_S - 2.5 * WEEK;

const RAW_GOAL: RawGoal = {
  id: 4n,
  owner: USER,
  integrator: INTEGRATOR,
  integrator_fee_bps: 50,
  loktin_fee_bps: 25,
  target: 1000n,
  deadline: BigInt(START_S + 10 * WEEK),
  cadence: BigInt(WEEK),
  deposit_size: 100n,
  rule: { tag: 'Penalty', values: [500] },
  start: BigInt(START_S),
  principal: 200n,
  shares: 200n,
  last_collected_period: 2n,
  missed_count: 0n,
};

const GOAL: Goal = {
  id: 4n,
  owner: USER,
  integrator: INTEGRATOR,
  integratorFeeBps: 50,
  loktinFeeBps: 25,
  target: 1000n,
  deadline: new Date((START_S + 10 * WEEK) * 1000),
  cadenceSeconds: WEEK,
  depositSize: 100n,
  rule: { kind: 'penalty', bps: 500 },
  start: new Date(START_S * 1000),
  principal: 200n,
  shares: 200n,
  lastCollectedPeriod: 2n,
  missedCount: 0n,
};

const RAW_WITHDRAWAL = {
  amount: 200n,
  penalty: 10n,
  loktin_fee: 0n,
  integrator_fee: 1n,
  to_user: 189n,
};
const WITHDRAWAL = {
  amount: 200n,
  penalty: 10n,
  loktinFee: 0n,
  integratorFee: 1n,
  toUser: 189n,
};

const NEW_GOAL: CreateGoalInput = {
  target: 1000n,
  deadline: new Date((NOW_S + 10 * WEEK) * 1000),
  cadenceSeconds: WEEK,
  depositSize: 70n,
  rule: { kind: 'penalty', bps: 500 },
};

let server: FakeServer;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  server = new FakeServer();
});

afterEach(() => {
  vi.useRealTimers();
});

function module(): TargetSavings {
  return new TargetSavings(loktinOn(server), OPTIONS);
}

const i128 = (value: bigint) => nativeToScVal(value, { type: 'i128' });
const address = (value: string) => new Address(value).toScVal();

describe('Target Savings writes', () => {
  it('createGoal encodes every argument, with the automatic allowance', async () => {
    queueWrite(server, retvalOf('target-savings', 'create_goal', 9n));
    const created = await settle(module().createGoal(NEW_GOAL));

    // Ten weekly deposits of 70 before the deadline; the expiry is the
    // deadline's ledger plus one day.
    const expiry = 1_000_000 + (10 * WEEK) / 5 + 17_280;
    expect(created).toMatchObject({
      result: 9n,
      allowance: { amount: 700n, expiryLedger: expiry, periods: 10n },
    });
    const [call] = server.invocations();
    expect(call?.contractId).toBe(TS);
    expect(call?.method).toBe('create_goal');
    expect(xdrOf(call?.args ?? [])).toEqual(
      xdrOf([
        address(USER),
        i128(1000n),
        ScVal.scvU64(BigInt(NOW_S + 10 * WEEK)),
        ScVal.scvU64(BigInt(WEEK)),
        i128(70n),
        ScVal.scvVec([ScVal.scvSymbol('Penalty'), ScVal.scvU32(500)]),
        address(INTEGRATOR),
        ScVal.scvU32(50),
        ScVal.scvVec([i128(700n), ScVal.scvU32(expiry)]),
      ]),
    );
    expect(server.calls[0]).toEqual({
      method: 'getLedgerEntries',
      keys: ['configSetting'],
    });
  });

  it("createGoal passes a lock rule, and no allowance for 'none'", async () => {
    queueWrite(server, retvalOf('target-savings', 'create_goal', 9n));
    await settle(
      module().createGoal({
        ...NEW_GOAL,
        rule: { kind: 'lock' },
        allowance: 'none',
      }),
    );
    const [call] = server.invocations();
    expect(xdrOf(call?.args.slice(5, 6) ?? [])).toEqual(
      xdrOf([ScVal.scvVec([ScVal.scvSymbol('Lock')])]),
    );
    expect(xdrOf(call?.args.slice(8) ?? [])).toEqual(xdrOf([ScVal.scvVoid()]));
    expect(server.methods()).not.toContain('getLedgerEntries');
  });

  it('createGoal passes an explicit allowance as given', async () => {
    queueWrite(server, retvalOf('target-savings', 'create_goal', 9n));
    await settle(
      module().createGoal({
        ...NEW_GOAL,
        allowance: { amount: 5n, expiryLedger: 1_000_100 },
      }),
    );
    const [call] = server.invocations();
    expect(xdrOf(call?.args.slice(8) ?? [])).toEqual(
      xdrOf([ScVal.scvVec([i128(5n), ScVal.scvU32(1_000_100)])]),
    );
  });

  it('deposit, withdraw and collect call their functions for publicKey', async () => {
    // The fake repeats its last answer, so all three are queued first.
    queueWrite(server, ScVal.scvVoid());
    queueWrite(server, retvalOf('target-savings', 'withdraw', RAW_WITHDRAWAL));
    queueWrite(server, ScVal.scvVoid());
    await expect(settle(module().deposit(4n, 30n))).resolves.toMatchObject({
      result: null,
    });
    await expect(settle(module().withdraw(4n))).resolves.toMatchObject({
      result: WITHDRAWAL,
    });
    await settle(module().collect(4n));

    const calls = server.invocations();
    expect(calls.map((call) => call.method)).toEqual([
      'deposit',
      'withdraw',
      'collect',
    ]);
    expect(xdrOf(calls[0]?.args ?? [])).toEqual(
      xdrOf([address(USER), ScVal.scvU64(4n), i128(30n)]),
    );
    expect(xdrOf(calls[1]?.args ?? [])).toEqual(
      xdrOf([address(USER), ScVal.scvU64(4n)]),
    );
    expect(xdrOf(calls[2]?.args ?? [])).toEqual(xdrOf([ScVal.scvU64(4n)]));
  });

  it('renewAllowance approves the remaining deposits, with one token lookup per instance', async () => {
    server.simulateBy = (call) =>
      call.method === 'goal'
        ? simulationSuccess(retvalOf('target-savings', 'goal', RAW_GOAL))
        : undefined;
    queueWrite(server, ScVal.scvVoid());
    const targetSavings = module();
    const renewed = await settle(targetSavings.renewAllowance(4n));

    // Periods 3 to 10 remain: 8 × 100, which is what the goal still needs.
    const expiry = 1_000_000 + (7.5 * WEEK) / 5 + 17_280;
    expect(renewed).toMatchObject({
      result: null,
      allowance: { amount: 800n, expiryLedger: expiry, periods: 8n },
    });
    const approve = server.invocations().find((c) => c.method === 'approve');
    expect(approve?.contractId).toBe(USDC);
    expect(xdrOf(approve?.args ?? [])).toEqual(
      xdrOf([address(USER), address(TS), i128(800n), ScVal.scvU32(expiry)]),
    );

    await settle(targetSavings.renewAllowance(4n));
    const lookups = server.calls.filter(
      (call) =>
        call.method === 'getLedgerEntries' &&
        call.keys?.includes('contractData'),
    );
    expect(lookups).toHaveLength(1);
    expect(
      server.invocations().filter((c) => c.method === 'approve'),
    ).toHaveLength(2);
  });
});

describe('Target Savings reads', () => {
  it('decode goals into the camelCase types', async () => {
    server.simulateBy = (call) => {
      switch (call.method) {
        case 'goal':
          return simulationSuccess(
            retvalOf('target-savings', 'goal', RAW_GOAL),
          );
        case 'user_goals':
        case 'open_goals':
          return simulationSuccess(
            retvalOf('target-savings', call.method, [RAW_GOAL]),
          );
        default:
          return undefined;
      }
    };
    const targetSavings = module();
    await expect(targetSavings.goal(4n)).resolves.toEqual(GOAL);
    await expect(targetSavings.userGoals()).resolves.toEqual([GOAL]);
    await expect(targetSavings.userGoals(INTEGRATOR)).resolves.toEqual([GOAL]);
    await expect(targetSavings.openGoals(1n, 50)).resolves.toEqual([GOAL]);

    const calls = server.invocations();
    expect(calls.map((call) => call.method)).toEqual([
      'goal',
      'user_goals',
      'user_goals',
      'open_goals',
    ]);
    expect(xdrOf(calls[1]?.args ?? [])).toEqual(xdrOf([address(USER)]));
    expect(xdrOf(calls[2]?.args ?? [])).toEqual(xdrOf([address(INTEGRATOR)]));
    expect(xdrOf(calls[3]?.args ?? [])).toEqual(
      xdrOf([ScVal.scvU64(1n), ScVal.scvU32(50)]),
    );
  });

  it('read the settings, one call each', async () => {
    const answers: Record<string, ScVal> = {
      next_id: ScVal.scvU64(12n),
      preview_withdraw: retvalOf(
        'target-savings',
        'preview_withdraw',
        RAW_WITHDRAWAL,
      ),
      token: address(USDC),
      loktin_fee_bps: ScVal.scvU32(25),
      fee_recipient: address(INTEGRATOR),
      min_cadence: ScVal.scvU64(86_400n),
      paused: ScVal.scvBool(false),
    };
    server.simulateBy = (call) => {
      const retval = answers[call.method];
      return retval === undefined ? undefined : simulationSuccess(retval);
    };
    const targetSavings = module();
    await expect(targetSavings.nextId()).resolves.toBe(12n);
    await expect(targetSavings.previewWithdraw(4n)).resolves.toEqual(
      WITHDRAWAL,
    );
    await expect(targetSavings.token()).resolves.toBe(USDC);
    await expect(targetSavings.loktinFeeBps()).resolves.toBe(25);
    await expect(targetSavings.feeRecipient()).resolves.toBe(INTEGRATOR);
    await expect(targetSavings.minCadence()).resolves.toBe(86_400);
    await expect(targetSavings.paused()).resolves.toBe(false);
    expect(server.methods()).toEqual(Array(7).fill('simulateTransaction'));
    expect(server.invocations().map((call) => call.method)).toEqual(
      Object.keys(answers),
    );
  });

  it('allowanceStatus reads the goal and the allowance, and reports a shortfall', async () => {
    let allowance = 60n;
    server.simulateBy = (call) => {
      if (call.method === 'goal') {
        return simulationSuccess(retvalOf('target-savings', 'goal', RAW_GOAL));
      }
      if (call.method === 'allowance') {
        expect(call.contractId).toBe(USDC);
        expect(xdrOf(call.args)).toEqual(xdrOf([address(USER), address(TS)]));
        return simulationSuccess(i128(allowance));
      }
      return undefined;
    };
    const targetSavings = module();
    await expect(targetSavings.allowanceStatus(4n)).resolves.toEqual({
      allowance: 60n,
      nextAmount: 100n,
      short: true,
    });
    allowance = 100n;
    await expect(targetSavings.allowanceStatus(4n)).resolves.toEqual({
      allowance: 100n,
      nextAmount: 100n,
      short: false,
    });
  });
});

describe('the read adapter', () => {
  it('serves the reads it has a method for, and the rest go to the chain', async () => {
    const goal = vi.fn((goalId: bigint) =>
      Promise.resolve({ ...GOAL, id: goalId }),
    );
    server.simulateBy = (call) =>
      call.method === 'next_id'
        ? simulationSuccess(ScVal.scvU64(12n))
        : undefined;
    const targetSavings = new TargetSavings(
      loktinOn(server, { targetSavings: { goal } }),
      OPTIONS,
    );
    await expect(targetSavings.goal(7n)).resolves.toEqual({ ...GOAL, id: 7n });
    expect(goal).toHaveBeenCalledWith(7n);
    expect(server.calls).toEqual([]);

    await expect(targetSavings.nextId()).resolves.toBe(12n);
    expect(server.invocations().map((call) => call.method)).toEqual([
      'next_id',
    ]);
  });

  it('is never used by a write', async () => {
    const goal = vi.fn(() => Promise.resolve(GOAL));
    server.simulateBy = (call) =>
      call.method === 'goal'
        ? simulationSuccess(retvalOf('target-savings', 'goal', RAW_GOAL))
        : undefined;
    queueWrite(server, ScVal.scvVoid());
    const targetSavings = new TargetSavings(
      loktinOn(server, { targetSavings: { goal } }),
      OPTIONS,
    );
    await settle(targetSavings.renewAllowance(4n));
    expect(goal).not.toHaveBeenCalled();
  });
});

describe('Target Savings checks before any network call', () => {
  async function refused(
    call: () => Promise<unknown>,
    errorName: string,
  ): Promise<void> {
    const error = await call().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidInputError);
    expect((error as Error).message).toContain(errorName);
    expect(server.calls).toEqual([]);
  }

  it('refuse each createGoal input the contract would refuse', async () => {
    const targetSavings = module();
    const create = (change: Partial<CreateGoalInput>) => () =>
      targetSavings.createGoal({ ...NEW_GOAL, ...change });
    await refused(create({ target: 0n }), 'InvalidTarget');
    await refused(create({ depositSize: 0n }), 'InvalidDeposit');
    await refused(create({ deadline: NOW }), 'InvalidDeadline');
    await refused(
      create({
        deadline: new Date((NOW_S + WEEK - 1) * 1000),
        cadenceSeconds: WEEK,
      }),
      'NoPeriodBeforeDeadline',
    );
    await refused(
      create({ rule: { kind: 'penalty', bps: 1001 } }),
      'RateAboveCap',
    );
  });

  it('refuse an integrator fee above 100 or the contract as integrator, when the module is created', () => {
    const loktin = loktinOn(server);
    expect(
      () => new TargetSavings(loktin, { ...OPTIONS, integratorFeeBps: 101 }),
    ).toThrow(/RateAboveCap/);
    expect(
      () => new TargetSavings(loktin, { ...OPTIONS, integrator: TS }),
    ).toThrow(/InvalidIntegrator/);
    expect(
      () => new TargetSavings(loktin, { ...OPTIONS, integrator: 'G' }),
    ).toThrow(InvalidInputError);
    expect(server.calls).toEqual([]);
  });

  it('refuse a deposit that is not above zero, and a page outside 1 to 50', async () => {
    await refused(() => module().deposit(4n, 0n), 'InvalidDeposit');
    await refused(() => module().openGoals(1n, 51), 'InvalidLimit');
    await refused(() => module().openGoals(1n, 0), 'InvalidLimit');
  });
});
