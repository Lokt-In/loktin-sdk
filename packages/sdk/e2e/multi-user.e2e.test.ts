// T8 (W69): many users on one instance at the same time. Ten users, two
// integrators and 60 goals in mixed states, with the money rules checked
// after every step. The file deploys its own instance, so state left by
// the other files cannot affect its sums.
import { Keypair, scValToNative } from '@stellar/stellar-sdk/base';
import { basicNodeSigner } from '@stellar/stellar-sdk/contract';
import { Server } from '@stellar/stellar-sdk/rpc';
import { ScVal } from '@stellar/stellar-sdk/xdr';
import {
  ContractError,
  type Loktin,
  type NetworkSettings,
  createLoktin,
  toBaseUnits,
} from '@loktin/sdk';
import { SpendSave } from '@loktin/sdk/spend-save';
import { TargetSavings } from '@loktin/sdk/target-savings';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  MIN_CADENCE,
  NETWORK,
  PASSPHRASE,
  context,
  deployInstance,
  freshIntegrator,
  sleep,
  stellar,
  utcDay,
} from './context.js';

const ctx = context();
const USERS = 10;
const GOALS_PER_USER = 6;
/** The tenth user can afford one deposit and nothing more. */
const SHORT = 9;
const FUNDS = toBaseUnits('1000');
/** Waited past each period boundary, since ledger time trails the clock. */
const MARGIN_MS = 6000;
const windowOpen = utcDay() <= 28;
const withdrawalDay = windowOpen ? utcDay() : 1;

interface User {
  readonly index: number;
  readonly address: string;
  readonly loktin: Loktin;
}

/** What the scenario expects of each goal. */
interface ModelGoal {
  readonly id: bigint;
  readonly owner: number;
  readonly k: number;
  readonly integrator: string;
  readonly depositSize: bigint;
  readonly target: bigint;
  readonly lock: boolean;
  principal: bigint;
  lastCollectedPeriod: bigint;
  missedCount: bigint;
  open: boolean;
  /** The goal's ledger start, in milliseconds, read after creation. */
  start: number;
}

let network: NetworkSettings;
/** The ledger just before the scenario's first goal. */
let startLedger = 0;
let reader: Loktin;
let users: User[] = [];
let integrators: [string, string];
/** A third integrator, only for the cross-user enrolment. */
let crossIntegrator: string;
const feeBps = new Map<string, number>();
const goals: ModelGoal[] = [];
/** Expected accrued fees per recipient, in each contract. */
const accrued = {
  'target-savings': new Map<string, bigint>(),
  'spend-save': new Map<string, bigint>(),
};
/** Expected Spend & Save balance per enrolment, keyed `user:integrator`. */
const enrolments = new Map<string, bigint>();

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const feeRecipient = ctx.addresses['fee-recipient'];

function savingsFor(user: User, integrator: string): TargetSavings {
  return new TargetSavings(user.loktin, {
    integrator,
    integratorFeeBps: feeBps.get(integrator) ?? 0,
  });
}

function spendSaveFor(user: User, integrator: string): SpendSave {
  return new SpendSave(user.loktin, {
    integrator,
    integratorFeeBps: feeBps.get(integrator) ?? 0,
  });
}

// Reads for any address need no signer.
function readSavings(): TargetSavings {
  return new TargetSavings(reader, {
    integrator: integrators[0],
    integratorFeeBps: 0,
  });
}

function credit(
  contract: keyof typeof accrued,
  recipient: string,
  amount: bigint,
): void {
  const fees = accrued[contract];
  fees.set(recipient, (fees.get(recipient) ?? 0n) + amount);
}

/**
 * Runs each user's steps one at a time, and the users at the same time.
 * Every user finishes before a failure is reported, so no write from this
 * step can overlap the next one.
 */
async function perUser(
  who: readonly User[],
  steps: (user: User) => Promise<void>,
): Promise<void> {
  const results = await Promise.allSettled(who.map(steps));
  for (const result of results) {
    if (result.status === 'rejected') {
      throw result.reason;
    }
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
}

async function goalSnapshot(): Promise<string[]> {
  const savings = readSavings();
  return Promise.all(
    users.map(async (user) => json(await savings.userGoals(user.address))),
  );
}

async function enrolmentSnapshot(): Promise<string[]> {
  return Promise.all(
    users.map(async (user) =>
      json(
        await Promise.all(
          [...integrators, crossIntegrator].map((integrator) =>
            reader
              .read('spend-save', 'enrollment', {
                user: user.address,
                integrator,
              })
              .catch((error: unknown) => {
                if (
                  error instanceof ContractError &&
                  error.errorName === 'EnrollmentNotFound'
                ) {
                  return null;
                }
                throw error;
              }),
          ),
        ),
      ),
    ),
  );
}

/** No cross-user effects: only the users who acted have changed records. */
function onlyActorsChanged(
  before: readonly string[],
  after: readonly string[],
  actors: ReadonlySet<number>,
): void {
  const changed = after.flatMap((record, index) =>
    record === before[index] ? [] : [index],
  );
  expect(changed.filter((index) => !actors.has(index))).toEqual([]);
}

/** Every open goal on chain matches the model, user by user. */
async function goalsMatchModel(): Promise<void> {
  const savings = readSavings();
  for (const user of users) {
    const onChain = await savings.userGoals(user.address);
    const expected = goals
      .filter((goal) => goal.owner === user.index && goal.open)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((goal) => ({
        id: goal.id,
        owner: user.address,
        integrator: goal.integrator,
        principal: goal.principal,
        lastCollectedPeriod: goal.lastCollectedPeriod,
        missedCount: goal.missedCount,
      }));
    expect(
      [...onChain]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((goal) => ({
          id: goal.id,
          owner: goal.owner,
          integrator: goal.integrator,
          principal: goal.principal,
          lastCollectedPeriod: goal.lastCollectedPeriod,
          missedCount: goal.missedCount,
        })),
    ).toEqual(expected);
  }
}

/**
 * The books balance, and fees go to the right recipient: each contract
 * holds its open principals plus every recipient's accrued fees, and each
 * recipient's accrued fees are exactly the model's.
 */
async function booksBalance(): Promise<void> {
  const recipients = [...integrators, crossIntegrator, feeRecipient];
  const savings = readSavings();
  const spendSave = new SpendSave(reader, {
    integrator: integrators[0],
    integratorFeeBps: 0,
  });
  for (const [contract, module] of [
    ['target-savings', savings],
    ['spend-save', spendSave],
  ] as const) {
    let fees = 0n;
    for (const recipient of recipients) {
      const owed = await module.accruedFees(recipient);
      expect(owed, `${contract} accrued fees of ${recipient}`).toBe(
        accrued[contract].get(recipient) ?? 0n,
      );
      fees += owed;
    }
    const principals =
      contract === 'target-savings'
        ? goals
            .filter((goal) => goal.open)
            .reduce((sum, goal) => sum + goal.principal, 0n)
        : [...enrolments.values()].reduce((sum, value) => sum + value, 0n);
    const id =
      contract === 'target-savings'
        ? network.contracts.targetSavings
        : network.contracts.spendSave;
    const balance = await reader.read<bigint>('token', 'balance', { id });
    expect(balance, `${contract} token balance`).toBe(principals + fees);
  }
}

/** The checks run after every step. */
async function afterStep(
  before: readonly string[],
  actors: ReadonlySet<number>,
): Promise<void> {
  onlyActorsChanged(before, await goalSnapshot(), actors);
  await goalsMatchModel();
  await booksBalance();
}

/**
 * Collects `due` goals for `period`. The goals were created one after
 * another over about a minute, so each is collected once its own period is
 * due: each owner's goals one at a time, and the owners at the same time.
 */
async function collectPass(
  period: bigint,
  due: readonly ModelGoal[],
): Promise<void> {
  const before = await goalSnapshot();
  const actors = new Set(due.map((goal) => goal.owner));
  const cadence = MIN_CADENCE * 1000;
  await perUser(
    users.filter((user) => actors.has(user.index)),
    async (user) => {
      const savings = savingsFor(user, integrators[0]);
      const own = due
        .filter((g) => g.owner === user.index)
        .sort((a, b) => a.start - b.start);
      for (const goal of own) {
        const dueAt = goal.start + Number(period) * cadence + MARGIN_MS;
        await sleep(Math.max(0, dueAt - Date.now()));
        if (user.index === SHORT) {
          // Its balance is spent, so every collection is short.
          await expect(savings.collect(goal.id)).rejects.toMatchObject({
            code: 'CONTRACT_ERROR',
            number: 112,
            errorName: 'Shortfall',
          });
          continue;
        }
        await savings.collect(goal.id);
        goal.principal += min(goal.depositSize, goal.target - goal.principal);
        goal.missedCount += period - goal.lastCollectedPeriod - 1n;
        goal.lastCollectedPeriod = period;
        // Collected exactly once, checked at once while still in `period`.
        // A goal that just reached its target is refused for that first.
        expect((await savings.goal(goal.id)).lastCollectedPeriod).toBe(period);
        await expect(savings.collect(goal.id)).rejects.toMatchObject({
          errorName:
            goal.principal >= goal.target
              ? 'TargetReached'
              : 'AlreadyCollected',
        });
      }
    },
  );
  const after = await goalSnapshot();
  // Nothing changed for the short user.
  expect(after[SHORT]).toBe(before[SHORT]);
  await afterStep(before, actors);
}

describe('many users on one instance', () => {
  beforeAll(async () => {
    const cli = (args: readonly string[]) => stellar(ctx.configDir, args);
    const onLocal = ['--network', NETWORK];
    const { targetSavings, spendSave } = await deployInstance(
      ctx.configDir,
      ctx.addresses,
      ctx.token,
    );
    network = {
      passphrase: PASSPHRASE,
      rpcUrl: ctx.rpcUrl,
      contracts: { targetSavings, spendSave },
      token: ctx.token,
    };
    reader = createLoktin({ network });

    const aliases = Array.from(
      { length: USERS },
      (_, index) => `multi-user-${String(index)}`,
    );
    for (const alias of aliases) {
      await cli(['keys', 'generate', alias, ...onLocal, '--fund']);
    }
    await Promise.all(
      aliases.map((alias) =>
        cli([
          'tx',
          'new',
          'change-trust',
          '--line',
          ctx.asset,
          '--source-account',
          alias,
          ...onLocal,
        ]),
      ),
    );
    users = [];
    for (const [index, alias] of aliases.entries()) {
      const address = await cli(['keys', 'public-key', alias]);
      // The short user gets exactly one deposit of the smallest size.
      const amount = index === SHORT ? toBaseUnits('1') : FUNDS;
      await cli([
        'tx',
        'new',
        'payment',
        '--destination',
        address,
        '--asset',
        ctx.asset,
        '--amount',
        amount.toString(),
        '--source-account',
        'issuer',
        ...onLocal,
      ]);
      // Kept in memory only, never printed.
      const keypair = Keypair.fromSecret(await cli(['keys', 'secret', alias]));
      users.push({
        index,
        address,
        loktin: createLoktin({
          network,
          publicKey: address,
          signer: basicNodeSigner(keypair, PASSPHRASE),
        }),
      });
    }
    integrators = [freshIntegrator(), freshIntegrator()];
    crossIntegrator = freshIntegrator();
    feeBps.set(integrators[0], 100);
    feeBps.set(integrators[1], 50);
  });

  it('60 goals are created by all users at the same time', async () => {
    const before = await goalSnapshot();
    startLedger = (await reader.ledgerInfo()).latestLedger;
    const deadline = new Date(Date.now() + 2 * 60 * 60 * 1000);
    // Every user creates at once, each user's six one after another. Ids
    // come from each owner's own counter (W75), so no two conflict.
    await perUser(users, async (user) => {
      for (let k = 0; k < GOALS_PER_USER; k++) {
        const integrator = integrators[(user.index + k) % 2] ?? '';
        const depositSize = toBaseUnits(String(1 + (k % 3)));
        // Goal 4 needs only one and a half deposits, so its second
        // collection takes what is left.
        const target = k === 4 ? (depositSize * 3n) / 2n : depositSize * 100n;
        const lock = k % 3 === 2;
        const created = await savingsFor(user, integrator).createGoal({
          target,
          deadline,
          cadenceSeconds: MIN_CADENCE,
          depositSize,
          rule: lock
            ? { kind: 'lock' }
            : { kind: 'penalty', bps: k % 2 === 0 ? 500 : 1000 },
          allowance: 'auto',
        });
        goals.push({
          id: created.result,
          owner: user.index,
          k,
          integrator,
          depositSize,
          target,
          lock,
          principal: 0n,
          lastCollectedPeriod: 0n,
          missedCount: 0n,
          open: true,
          start: 0,
        });
      }
    });
    expect(goals).toHaveLength(USERS * GOALS_PER_USER);
    expect(new Set(goals.map((goal) => goal.id)).size).toBe(goals.length);
    // The short user spends its whole balance on one manual deposit.
    const short = users[SHORT];
    const first = goals.find((goal) => goal.owner === SHORT && goal.k === 0);
    if (short === undefined || first === undefined) throw new Error('setup');
    await savingsFor(short, first.integrator).deposit(
      first.id,
      toBaseUnits('1'),
    );
    first.principal = toBaseUnits('1');
    await afterStep(before, new Set(users.map((user) => user.index)));
    const savings = readSavings();
    await Promise.all(
      goals.map(async (goal) => {
        goal.start = (await savings.goal(goal.id)).start.getTime();
      }),
    );
  });

  it('collects period 1 for half of the goals, and leaves the rest', async () => {
    await collectPass(
      1n,
      goals.filter((goal) => goal.k % 2 === 0),
    );
  });

  it('collects period 2 for every goal, recording the missed period', async () => {
    // Goal 4 reaches its target in period 2 and is still collected once.
    await collectPass(2n, goals);
    for (const goal of goals.filter((g) => g.owner !== SHORT)) {
      expect(goal.missedCount).toBe(goal.k % 2 === 0 ? 0n : 1n);
    }
    const reached = goals.filter((g) => g.k === 4 && g.owner !== SHORT);
    expect(reached.every((goal) => goal.principal === goal.target)).toBe(true);
  });

  it('withdraws some goals, early with a penalty or at the target', async () => {
    const before = await goalSnapshot();
    const withdrawing = users.slice(0, 6);
    await perUser(withdrawing, async (user) => {
      for (const goal of goals.filter(
        (g) => g.owner === user.index && (g.k === 0 || g.k === 4),
      )) {
        const { result } = await savingsFor(user, goal.integrator).withdraw(
          goal.id,
        );
        expect(result.amount).toBe(goal.principal);
        // Goal 0 leaves early with its penalty; goal 4 reached its target.
        expect(result.penalty > 0n).toBe(goal.k === 0);
        credit(
          'target-savings',
          goal.integrator,
          result.penalty + result.integratorFee,
        );
        credit('target-savings', feeRecipient, result.loktinFee);
        goal.open = false;
      }
    });
    await afterStep(before, new Set(withdrawing.map((user) => user.index)));
  });

  it('finds every goal from its events and from userGoals', async () => {
    // Ids are not sequential, so goals are found from `goal_created`
    // events and, for an integrator's own users, from `userGoals`.
    const server = new Server(ctx.rpcUrl, { allowHttp: true });
    const filters = [
      {
        type: 'contract' as const,
        contractIds: [network.contracts.targetSavings],
        topics: [[ScVal.scvSymbol('goal_created').toXdr('base64'), '*', '*']],
      },
    ];
    const created: bigint[] = [];
    let page = await server.getEvents({ startLedger, filters, limit: 50 });
    for (;;) {
      for (const event of page.events) {
        const id = event.topic[1];
        if (id === undefined) throw new Error('goal_created without an id');
        created.push(scValToNative(id) as bigint);
      }
      if (page.events.length < 50) break;
      page = await server.getEvents({
        cursor: page.cursor,
        filters,
        limit: 50,
      });
    }
    const byId = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
    expect(created.sort(byId)).toEqual(goals.map((goal) => goal.id).sort(byId));

    const savings = readSavings();
    const listed = (
      await Promise.all(users.map((user) => savings.userGoals(user.address)))
    ).flatMap((own) => own.map((goal) => goal.id));
    expect(listed.sort(byId)).toEqual(
      goals
        .filter((goal) => goal.open)
        .map((goal) => goal.id)
        .sort(byId),
    );
  });

  it('refuses another user deposit or withdrawal on a goal', async () => {
    const [owner, other] = users;
    const target = goals.find((g) => g.owner === 0 && g.open);
    if (owner === undefined || other === undefined || target === undefined) {
      throw new Error('setup');
    }
    const before = await goalSnapshot();
    const savings = savingsFor(other, target.integrator);
    const notOwner = {
      code: 'CONTRACT_ERROR',
      number: 101,
      errorName: 'NotOwner',
    };
    await expect(
      savings.deposit(target.id, toBaseUnits('1')),
    ).rejects.toMatchObject(notOwner);
    await expect(savings.withdraw(target.id)).rejects.toMatchObject(notOwner);
    await afterStep(before, new Set());
  });

  describe('Spend & Save', () => {
    // User 0 enrols with both integrators, users 1 to 4 with one each.
    const enrolled = (): [User, string][] =>
      users.slice(0, 5).flatMap((user): [User, string][] =>
        user.index === 0
          ? [
              [user, integrators[0]],
              [user, integrators[1]],
            ]
          : [[user, integrators[user.index % 2] ?? '']],
      );
    const key = (user: User, integrator: string) =>
      `${String(user.index)}:${integrator}`;

    async function bySpendSave(
      steps: (user: User, integrator: string) => Promise<void>,
    ): Promise<void> {
      const pairs = enrolled();
      await perUser([...new Set(pairs.map(([user]) => user))], async (user) => {
        for (const [, integrator] of pairs.filter(([u]) => u === user)) {
          await steps(user, integrator);
        }
      });
    }

    beforeAll(() => {
      if (!windowOpen) {
        console.log(
          `UTC day ${String(utcDay())} cannot be a withdrawal day: the Spend & Save withdrawals are skipped.`,
        );
      }
    });

    it('enrols users with their integrators, and saves at the same time', async () => {
      const before = await enrolmentSnapshot();
      await bySpendSave(async (user, integrator) => {
        await spendSaveFor(user, integrator).enroll({
          skim: { percentBps: 1000 },
          destination: { kind: 'balance' },
          withdrawalDay,
        });
        enrolments.set(key(user, integrator), 0n);
      });
      await bySpendSave(async (user, integrator) => {
        const saved = await spendSaveFor(user, integrator).saveForSpend(
          toBaseUnits('100'),
        );
        expect(saved.result.toBalance).toBe(toBaseUnits('10'));
        enrolments.set(key(user, integrator), toBaseUnits('10'));
      });
      onlyActorsChanged(
        before,
        await enrolmentSnapshot(),
        new Set([0, 1, 2, 3, 4]),
      );
      await booksBalance();
    });

    it.skipIf(!windowOpen)(
      'withdraws, and each integrator accrues only its own fees',
      async () => {
        const before = await enrolmentSnapshot();
        await bySpendSave(async (user, integrator) => {
          const { result } = await spendSaveFor(user, integrator).withdraw(
            toBaseUnits('5'),
          );
          credit('spend-save', integrator, result.integratorFee);
          credit('spend-save', feeRecipient, result.loktinFee);
          enrolments.set(key(user, integrator), toBaseUnits('5'));
        });
        onlyActorsChanged(
          before,
          await enrolmentSnapshot(),
          new Set([0, 1, 2, 3, 4]),
        );
        // Integrator 1 charges 1% on three enrolments, integrator 2 0.5% on
        // three: 5 withdrawn from each.
        expect(accrued['spend-save'].get(integrators[0])).toBe(
          toBaseUnits('0.15'),
        );
        expect(accrued['spend-save'].get(integrators[1])).toBe(
          toBaseUnits('0.075'),
        );
        await booksBalance();
      },
    );

    it("saves a skim aimed at another user's goal to the sender's balance", async () => {
      const [, other] = users;
      const target = goals.find((g) => g.owner === 0 && g.open);
      if (other === undefined || target === undefined) throw new Error('setup');
      const goalsBefore = await goalSnapshot();
      const enrolmentsBefore = await enrolmentSnapshot();
      const spendSave = spendSaveFor(other, crossIntegrator);
      await spendSave.enroll({
        skim: { percentBps: 1000 },
        destination: { kind: 'goal', goalId: target.id },
        withdrawalDay,
      });
      const saved = await spendSave.saveForSpend(toBaseUnits('10'));
      expect(saved.result).toMatchObject({
        toGoal: 0n,
        toBalance: toBaseUnits('1'),
        goalId: undefined,
      });
      enrolments.set(key(other, crossIntegrator), toBaseUnits('1'));
      onlyActorsChanged(
        enrolmentsBefore,
        await enrolmentSnapshot(),
        new Set([other.index]),
      );
      // The owner's goal is unchanged, and so is every other goal.
      await afterStep(goalsBefore, new Set());
    });
  });
});
