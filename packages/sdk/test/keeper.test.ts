import {
  Address,
  StrKey,
  TransactionBuilder,
  scValToNative,
} from '@stellar/stellar-sdk/base';
import type { SignTransaction } from '@stellar/stellar-sdk/contract';
import type { Api } from '@stellar/stellar-sdk/rpc';
import { ScMapEntry, ScVal } from '@stellar/stellar-sdk/xdr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InvalidInputError,
  NetworkError,
  TESTNET,
  createLoktin,
} from '../src/index.js';
import {
  FeeAboveCeilingError,
  feeCeilingSigner,
  isDue,
  START_MARGIN_LEDGERS,
  runPass,
  scanGoals,
  scanStart,
} from '../src/keeper/index.js';
import type { Goal } from '../src/target-savings/index.js';
import type { RawGoal } from '../src/target-savings/types.js';
import {
  FakeServer,
  TESTNET_PASSPHRASE,
  USER,
  callEvent,
  errorEvent,
  simulationFailure,
  simulationSuccess,
} from './fake-server.js';
import { passThroughSigner, queueWrite, retvalOf, settle } from './modules.js';

const TS = TESTNET.contracts.targetSavings;
const INTEGRATOR_A = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(1));
const INTEGRATOR_B = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(2));
const OWNER = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(4));
const DAY = 86_400;
const START = Date.UTC(2026, 9, 28, 16, 49) / 1000;

function goal(change: Partial<Goal> = {}): Goal {
  return {
    id: 1n,
    owner: USER,
    integrator: INTEGRATOR_A,
    integratorFeeBps: 50,
    loktinFeeBps: 0,
    target: 50_000_000n,
    deadline: new Date((START + 7 * DAY) * 1000),
    cadenceSeconds: DAY,
    depositSize: 10_000_000n,
    rule: { kind: 'penalty', bps: 500 },
    start: new Date(START * 1000),
    principal: 0n,
    shares: 0n,
    lastCollectedPeriod: 0n,
    missedCount: 0n,
    ...change,
  };
}

function rawGoal(id: bigint, integrator: string, owner = USER): RawGoal {
  return {
    id,
    owner,
    integrator,
    integrator_fee_bps: 50,
    loktin_fee_bps: 0,
    target: 50_000_000n,
    deadline: BigInt(START + 7 * DAY),
    cadence: BigInt(DAY),
    deposit_size: 10_000_000n,
    rule: { tag: 'Penalty', values: [500] },
    start: BigInt(START),
    principal: 0n,
    shares: 0n,
    last_collected_period: 0n,
    missed_count: 0n,
  };
}

const at = (seconds: number) => new Date(seconds * 1000);

describe('isDue', () => {
  it('is false in period 0, before the first period starts', () => {
    expect(isDue(goal(), at(START))).toBe(false);
    expect(isDue(goal(), at(START + DAY - 1))).toBe(false);
    expect(isDue(goal(), at(START - 10))).toBe(false);
  });

  it('is true once a period starts, and false again once it is collected', () => {
    expect(isDue(goal(), at(START + DAY))).toBe(true);
    expect(isDue(goal({ lastCollectedPeriod: 1n }), at(START + DAY))).toBe(
      false,
    );
    expect(isDue(goal({ lastCollectedPeriod: 1n }), at(START + 2 * DAY))).toBe(
      true,
    );
  });

  it('is true at the deadline second and false after it', () => {
    const deadline = START + 7 * DAY;
    expect(isDue(goal(), at(deadline))).toBe(true);
    expect(isDue(goal(), at(deadline + 1))).toBe(false);
  });

  it('is false once the target is reached', () => {
    expect(isDue(goal({ principal: 50_000_000n }), at(START + DAY))).toBe(
      false,
    );
    expect(isDue(goal({ principal: 49_999_999n }), at(START + DAY))).toBe(true);
  });
});

// A `goal_created` or `goal_closed` event, as getEvents parses it.
function event(
  name: 'goal_created' | 'goal_closed',
  id: bigint,
  integrator: string,
): Api.EventResponse {
  return {
    id: `${name}-${id.toString()}`,
    type: 'contract',
    ledger: 900_000,
    ledgerClosedAt: '2026-10-28T16:49:00Z',
    transactionIndex: 1,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: 'ab'.repeat(32),
    topic: [
      ScVal.scvSymbol(name),
      ScVal.scvU64(id),
      new Address(USER).toScVal(),
    ],
    value:
      name === 'goal_created'
        ? ScVal.scvMap([
            new ScMapEntry({
              key: ScVal.scvSymbol('integrator'),
              val: new Address(integrator).toScVal(),
            }),
          ])
        : ScVal.scvVoid(),
  };
}

function page(
  events: Api.EventResponse[],
  cursor: string,
): Api.GetEventsResponse {
  return {
    events,
    cursor,
    latestLedger: 1_000_000,
    oldestLedger: 879_040,
    latestLedgerCloseTime: '0',
    oldestLedgerCloseTime: '0',
  };
}

let server: FakeServer;

beforeEach(() => {
  server = new FakeServer();
  // Goals 1 and 3 through integrator A, goal 2 through B; goal 3 closed.
  // Two empty pages move the cursor before it stops changing.
  server.eventPages.set(
    'start',
    page(
      [
        event('goal_created', 1n, INTEGRATOR_A),
        event('goal_created', 2n, INTEGRATOR_B),
        event('goal_created', 3n, INTEGRATOR_A),
        event('goal_closed', 3n, INTEGRATOR_A),
      ],
      'c1',
    ),
  );
  server.eventPages.set('c1', page([], 'c2'));
  server.eventPages.set('c2', page([], 'c3'));
  server.eventPages.set('c3', page([], 'c3'));
  server.simulateBy = (call) => {
    if (call.method === 'goal') {
      const id = scValToNative(call.args[0] as ScVal) as bigint;
      if (id === 7n) {
        return simulationFailure('HostError', [errorEvent(TS, 100)]);
      }
      return simulationSuccess(
        retvalOf(
          'target-savings',
          'goal',
          rawGoal(id, id === 2n ? INTEGRATOR_B : INTEGRATOR_A),
        ),
      );
    }
    if (call.method === 'user_goals') {
      return simulationSuccess(
        retvalOf('target-savings', 'user_goals', [
          rawGoal(1n, INTEGRATOR_A, OWNER),
          rawGoal(5n, INTEGRATOR_A, OWNER),
          rawGoal(6n, INTEGRATOR_B, OWNER),
        ]),
      );
    }
    return undefined;
  };
});

afterEach(() => {
  vi.useRealTimers();
});

const reader = () => createLoktin({ network: 'testnet', server });
const ids = (goals: readonly Goal[]) => goals.map((g) => g.id).sort();

describe('scanGoals', () => {
  it('follows the cursor through empty pages until it stops changing', async () => {
    const scan = await scanGoals(reader(), { integrators: [INTEGRATOR_A] });
    expect(ids(scan.goals)).toEqual([1n]);
    // The scan starts 60 ledgers after the RPC's oldest ledger.
    expect(scan).toMatchObject({
      events: 4,
      pages: 4,
      fromLedger: 879_040 + 60,
      toLedger: 1_000_000,
    });
    expect(
      server.calls.find((call) => call.method === 'getEvents')?.startLedger,
    ).toBe(879_100);
    expect(
      server.calls
        .filter((call) => call.method === 'getEvents')
        .map((call) => call.cursor),
    ).toEqual([undefined, 'c1', 'c2', 'c3']);
  });

  it("serves every integrator with 'all', still without closed goals", async () => {
    const scan = await scanGoals(reader(), { integrators: 'all' });
    expect(ids(scan.goals)).toEqual([1n, 2n]);
  });

  it("adds the owners' goals, filtered by integrator and without duplicates", async () => {
    const scan = await scanGoals(reader(), {
      integrators: [INTEGRATOR_A],
      owners: [OWNER],
    });
    expect(ids(scan.goals)).toEqual([1n, 5n]);
    // Goal 1 came from the owner's list, so it is not read again.
    expect(
      server.invocations().filter((call) => call.method === 'goal'),
    ).toHaveLength(0);
  });

  it('drops a goal that closed after its last event', async () => {
    server.eventPages.set(
      'start',
      page([event('goal_created', 7n, INTEGRATOR_A)], 'c3'),
    );
    const scan = await scanGoals(reader(), { integrators: [INTEGRATOR_A] });
    expect(scan.goals).toEqual([]);
  });

  it('uses the margin only once the retention window is full', () => {
    const health = (oldestLedger: number, latestLedger: number) => ({
      status: 'healthy' as const,
      oldestLedger,
      latestLedger,
      ledgerRetentionWindow: 120_960,
    });
    // A full window, as on testnet: it moves, so the scan starts 60 in.
    expect(scanStart(health(5_436_500, 5_557_459))).toBe(5_436_560);
    // A young window does not move: start at its oldest ledger, so no
    // event is skipped and the start never passes the latest ledger.
    expect(scanStart(health(7, 43))).toBe(7);
    expect(START_MARGIN_LEDGERS).toBe(60);
  });

  it('starts again from a fresh oldest ledger when the RPC refuses the start', async () => {
    server.oldestLedgers.push(879_040, 879_050);
    server.eventErrors.push({
      code: -32600,
      message: 'startLedger must be within the ledger range: 879101 - 1000000',
    });
    const scan = await scanGoals(reader(), { integrators: [INTEGRATOR_A] });
    expect(ids(scan.goals)).toEqual([1n]);
    expect(scan.fromLedger).toBe(879_110);
    expect(
      server.calls
        .filter((call) => call.method === 'getEvents')
        .slice(0, 2)
        .map((call) => call.startLedger),
    ).toEqual([879_100, 879_110]);
    expect(server.methods().filter((m) => m === 'getHealth')).toHaveLength(2);
  });

  it('passes any other RPC refusal on as NETWORK, without retrying', async () => {
    server.eventErrors.push({ code: -32603, message: 'internal error' });
    await expect(
      scanGoals(reader(), { integrators: [INTEGRATOR_A] }),
    ).rejects.toMatchObject({
      code: 'NETWORK',
      message: 'the RPC refused the event scan: internal error',
    });
    expect(server.methods().filter((m) => m === 'getEvents')).toHaveLength(1);
  });

  describe('on network errors', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('retries getHealth', async () => {
      server.healthErrors.push(new Error('fetch failed'));
      const scan = (await settle(
        scanGoals(reader(), { integrators: [INTEGRATOR_A] }),
      )) as Awaited<ReturnType<typeof scanGoals>>;
      expect(ids(scan.goals)).toEqual([1n]);
      expect(server.methods().filter((m) => m === 'getHealth')).toHaveLength(2);
    });

    it('retries a later page from the last cursor received', async () => {
      server.eventErrors.push(null, new Error('fetch failed'));
      const scan = (await settle(
        scanGoals(reader(), { integrators: [INTEGRATOR_A] }),
      )) as Awaited<ReturnType<typeof scanGoals>>;
      expect(ids(scan.goals)).toEqual([1n]);
      expect(
        server.calls
          .filter((call) => call.method === 'getEvents')
          .map((call) => call.cursor),
      ).toEqual([undefined, 'c1', 'c1', 'c2', 'c3']);
    });

    it('gives NETWORK after the last retry, at 0.5, 1 and 2 s', async () => {
      server.healthErrors.push(
        ...Array.from({ length: 4 }, () => new Error('fetch failed')),
      );
      const scan = scanGoals(reader(), { integrators: [INTEGRATOR_A] }).catch(
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(3_499);
      expect(server.methods()).toEqual(Array(3).fill('getHealth'));
      await vi.advanceTimersByTimeAsync(1);
      const error = await scan;
      expect(error).toBeInstanceOf(NetworkError);
      expect(error).toMatchObject({
        message: 'getHealth failed: fetch failed',
      });
      expect(server.methods()).toEqual(Array(4).fill('getHealth'));
    });
  });

  it('refuses bad options before any network call', async () => {
    for (const options of [
      { integrators: [] },
      { integrators: ['G'] },
      { integrators: [INTEGRATOR_A], owners: ['nope'] },
    ]) {
      await expect(scanGoals(reader(), options)).rejects.toThrow(
        InvalidInputError,
      );
    }
    expect(server.calls).toEqual([]);
  });
});

describe('runPass', () => {
  const now = () => at(START + DAY + 60);
  const keeper = (signTransaction: SignTransaction = passThroughSigner()) =>
    createLoktin({
      network: 'testnet',
      server,
      publicKey: USER,
      signer: { signTransaction },
    });
  const collectAnswer = (answer: Api.SimulateTransactionResponse) => {
    const reads = server.simulateBy;
    server.simulateBy = (call) =>
      call.method === 'collect' ? answer : reads?.(call);
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: now() });
  });

  it('collects a due goal and reports the amount', async () => {
    queueWrite(server, ScVal.scvVoid());
    collectAnswer(simulationSuccess(ScVal.scvVoid()));
    const pass = (await settle(
      runPass(keeper(), { integrators: [INTEGRATOR_A], now }),
    )) as Awaited<ReturnType<typeof runPass>>;
    expect(pass.failure).toBeUndefined();
    expect(pass.results).toEqual([
      {
        goalId: 1n,
        action: 'collected',
        hash: 'ab'.repeat(32),
        ledger: 101,
        amount: 10_000_000n,
      },
    ]);
  });

  it('reports a goal that is not due without calling collect', async () => {
    const pass = await runPass(keeper(), {
      integrators: [INTEGRATOR_A],
      now: () => at(START + 60),
    });
    expect(pass.results).toEqual([{ goalId: 1n, action: 'not-due' }]);
    expect(server.invocations().map((call) => call.method)).not.toContain(
      'collect',
    );
  });

  it.each([
    [100, 'GoalNotFound'],
    [108, 'NotDue'],
    [109, 'AlreadyCollected'],
    [110, 'DeadlinePassed'],
    [111, 'TargetReached'],
    [112, 'Shortfall'],
    [1000, 'EnforcedPause'],
  ])('skips contract error %i as %s', async (code, name) => {
    collectAnswer(
      simulationFailure('HostError', [callEvent(TS), errorEvent(TS, code)]),
    );
    const pass = (await settle(
      runPass(keeper(), { integrators: [INTEGRATOR_A], now }),
    )) as Awaited<ReturnType<typeof runPass>>;
    expect(pass.failure).toBeUndefined();
    expect(pass.results).toEqual([
      { goalId: 1n, action: 'skipped', reason: name },
    ]);
  });

  it('keeps the hash of a collect whose outcome is pending', async () => {
    collectAnswer(simulationSuccess(ScVal.scvVoid()));
    // The send itself fails, so the transaction may have reached the network.
    server.sends.push(new Error('fetch failed'));
    const pass = (await settle(
      runPass(keeper(), { integrators: [INTEGRATOR_A], now }),
    )) as Awaited<ReturnType<typeof runPass>>;
    expect(pass.failure).toMatchObject({ goalId: 1n, code: 'PENDING' });
    expect(pass.failure?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(server.methods()).toContain('sendTransaction');
  });

  it('stops the pass on any other error', async () => {
    collectAnswer(
      simulationFailure('HostError', [callEvent(TS), errorEvent(TS, 113)]),
    );
    const pass = (await settle(
      runPass(keeper(), { integrators: 'all', now }),
    )) as Awaited<ReturnType<typeof runPass>>;
    expect(pass.failure).toMatchObject({ goalId: 1n, code: 'CONTRACT_ERROR' });
    // Goal 2 was not tried after the failure.
    expect(pass.results).toEqual([]);
  });

  it('skips a goal whose fee is above the ceiling, without signing', async () => {
    collectAnswer(simulationSuccess(ScVal.scvVoid()));
    const inner = passThroughSigner();
    const pass = (await settle(
      runPass(keeper(feeCeilingSigner(inner, 1n, TESTNET_PASSPHRASE)), {
        integrators: [INTEGRATOR_A],
        now,
      }),
    )) as Awaited<ReturnType<typeof runPass>>;
    expect(pass.results).toEqual([
      { goalId: 1n, action: 'skipped', reason: 'FeeAboveCeiling' },
    ]);
    expect(inner).not.toHaveBeenCalled();
    expect(server.methods()).not.toContain('sendTransaction');
  });
});

describe('feeCeilingSigner', () => {
  it('passes an envelope at the ceiling on, and refuses one above it', async () => {
    server.simulateBy = () => simulationSuccess(ScVal.scvVoid());
    // Capture a real envelope from the SDK, then stop the write.
    let envelope = '';
    const capture: SignTransaction = (xdr) => {
      envelope = xdr;
      return Promise.reject(new Error('captured'));
    };
    await createLoktin({
      network: 'testnet',
      server,
      publicKey: USER,
      signer: { signTransaction: capture },
    })
      .write('target-savings', 'collect', { goal_id: 1n })
      .catch(() => undefined);
    const fee = BigInt(
      TransactionBuilder.fromXdr(envelope, TESTNET_PASSPHRASE).fee,
    );

    const inner = passThroughSigner();
    await expect(
      feeCeilingSigner(inner, fee, TESTNET_PASSPHRASE)(envelope),
    ).resolves.toMatchObject({ signedTxXdr: envelope });
    await expect(
      feeCeilingSigner(inner, fee - 1n, TESTNET_PASSPHRASE)(envelope),
    ).rejects.toBeInstanceOf(FeeAboveCeilingError);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
