// Load and stress test (T10, W70, W71, W78, W149), on the private local
// network only. Run with
//
//   npm run sizing:load
//
// after `stellar contract build` and `npm run build`. LOAD_STEPS sets the
// steps of concurrent users (default 10,25,50,100,200,400,800): the first
// four are the load phase, the rest stress. Each step adds users, each with
// its own account, goal and enrolment, and runs 3 rounds of a deposit, a
// payAndSave and a goal read, with all its users at once. On stress steps a
// keeper pass with 4 channels runs at the same time. Afterwards the
// recovery checks must hold whatever the load did. The results go to
// LOAD_OUTPUT/load-test.json: measured data only, never a key.
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import {
  Asset,
  type FeeBumpTransaction,
  Keypair,
  Operation,
  type Transaction,
  TransactionBuilder,
  scValToNative,
} from '@stellar/stellar-sdk/base';
import { basicNodeSigner } from '@stellar/stellar-sdk/contract';
import { Api, Server } from '@stellar/stellar-sdk/rpc';
import { ScVal } from '@stellar/stellar-sdk/xdr';
import {
  type Loktin,
  LoktinError,
  type NetworkSettings,
  PendingError,
  TransactionFailedError,
  createLoktin,
  toBaseUnits,
} from '@loktin/sdk';
import { type PassResult, runPass, scanGoals } from '@loktin/sdk/keeper';
import { SpendSave } from '@loktin/sdk/spend-save';
import { TargetSavings } from '@loktin/sdk/target-savings';
import { expect, it } from 'vitest';
import {
  MIN_CADENCE,
  PASSPHRASE,
  context,
  deployInstance,
  freshIntegrator,
  network,
  sleep,
  stellar,
} from '../e2e/context.js';

const STEPS = (process.env['LOAD_STEPS'] ?? '10,25,50,100,200,400,800')
  .split(',')
  .map((step) => Number(step.trim()));
/** The first four steps are the load phase; the rest are stress. */
const LOAD_PHASE_STEPS = 4;
const ROUNDS = 3;
const DEPOSIT = toBaseUnits('1');
const SPEND = toBaseUnits('1');
const USER_TEST = toBaseUnits('2000');
const USER_XLM = '20';
/** Accounts created by one funder from Friendbot: 100 × 20 XLM and spare. */
const PER_FUNDER = 100;
const AT_ONCE = 25;
/** The breaking point (W70, W71): our own judgments. */
const MIN_SUCCESS = 0.95;
const MAX_P95_MS = 60_000;
const MAX_STEP_MS = 15 * 60_000;
/** One step past the breaking point only while the run is under this. */
const RUN_BUDGET_MS = 120 * 60_000;
/** Every SDK transaction's upper time bound (stellar-sdk's default). */
const TIME_BOUND_MS = 300_000;
/** Failures that are the user's own, not the system's. */
const OWN_CONTRACT_ERRORS = new Set([
  'ExceedsTarget',
  'TargetReached',
  'DeadlinePassed',
  'NotDue',
  'AlreadyCollected',
  'Shortfall',
  'ExceedsBalance',
  'BalanceNotZero',
]);

const ctx = context();
const base = ctx.rpcUrl.replace(/\/rpc$/, '');

/** An RPC server that counts sends, and TRY_AGAIN_LATER answers. */
class CountingServer extends Server {
  sends = 0;
  tryAgainLater = 0;

  override async sendTransaction(
    tx: Transaction | FeeBumpTransaction,
  ): Promise<Api.SendTransactionResponse> {
    const response = await super.sendTransaction(tx);
    this.sends += 1;
    if (response.status === 'TRY_AGAIN_LATER') {
      this.tryAgainLater += 1;
    }
    return response;
  }
}

const server = new CountingServer(ctx.rpcUrl, { allowHttp: true });

async function inPool<T>(
  items: readonly T[],
  size: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (let index = next++; index < items.length; index = next++) {
        await work(items[index] as T, index);
      }
    }),
  );
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) {
    out.push(items.slice(at, at + size));
  }
  return out;
}

/** Builds, signs and sends a classic transaction, and waits for it. */
async function submit(
  source: Keypair,
  operations: readonly Parameters<TransactionBuilder['addOperation']>[0][],
): Promise<void> {
  const account = await server.getAccount(source.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: '1000',
    networkPassphrase: PASSPHRASE,
  });
  for (const operation of operations) {
    builder.addOperation(operation);
  }
  const tx = builder.setTimeout(120).build();
  tx.sign(source);
  const sent = await server.sendTransaction(tx);
  if (sent.status !== 'PENDING') {
    throw new Error(`a setup transaction was ${sent.status}`);
  }
  for (;;) {
    await sleep(1000);
    const got = await server.getTransaction(sent.hash);
    if (got.status === Api.GetTransactionStatus.SUCCESS) {
      return;
    }
    if (got.status === Api.GetTransactionStatus.FAILED) {
      throw new Error(`setup transaction ${sent.hash} failed`);
    }
  }
}

/** New funded accounts, `PER_FUNDER` per funder from Friendbot. */
async function fundedAccounts(count: number, xlm: string): Promise<Keypair[]> {
  const keys = Array.from({ length: count }, () => Keypair.random());
  for (const batch of chunks(keys, PER_FUNDER)) {
    const funder = Keypair.random();
    const funded = await fetch(`${base}/friendbot?addr=${funder.publicKey()}`);
    if (!funded.ok) {
      throw new Error(`Friendbot answered ${String(funded.status)}`);
    }
    await submit(
      funder,
      batch.map((key) =>
        Operation.createAccount({
          destination: key.publicKey(),
          startingBalance: xlm,
        }),
      ),
    );
  }
  return keys;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function commit(): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', 'HEAD'], (error, stdout) => {
      resolve(error === null ? stdout.trim() : 'unknown');
    });
  });
}

interface User {
  readonly key: Keypair;
  readonly savings: TargetSavings;
  readonly spendSave: SpendSave;
  readonly goalId: bigint;
}

/** One write's outcome, for the step's figures and the recovery checks. */
interface Outcome {
  readonly ms: number;
  readonly ledger?: number;
  readonly code?: string;
  readonly own?: boolean;
  /** A hash whose outcome was not known when the call ended. */
  readonly pending?: { readonly hash: string; readonly validUntil?: Date };
}

function outcomeOf(error: unknown, ms: number): Outcome {
  if (!(error instanceof LoktinError)) {
    return { ms, code: 'UNEXPECTED' };
  }
  const name = 'errorName' in error ? String(error.errorName) : '';
  const own =
    error.code === 'TOKEN_ERROR' ||
    (error.code === 'CONTRACT_ERROR' && OWN_CONTRACT_ERRORS.has(name));
  if (error instanceof PendingError) {
    return {
      ms,
      code: error.code,
      own,
      pending: {
        hash: error.hash,
        ...(error.validUntil === undefined
          ? {}
          : { validUntil: error.validUntil }),
      },
    };
  }
  if (error instanceof TransactionFailedError) {
    return {
      ms,
      code: error.code,
      own,
      pending: { hash: error.hash },
    };
  }
  return { ms, code: name === '' ? error.code : `${error.code}:${name}`, own };
}

async function timedWrite(
  call: () => Promise<{ readonly ledger: number }>,
): Promise<Outcome> {
  const started = performance.now();
  try {
    const written = await call();
    return { ms: performance.now() - started, ledger: written.ledger };
  } catch (error) {
    return outcomeOf(error, performance.now() - started);
  }
}

interface KeeperFigures {
  readonly collected: number;
  readonly skipped: number;
  readonly notDue: number;
  readonly failed: number;
  readonly failure?: string;
}

function keeperFigures(pass: PassResult): KeeperFigures {
  const count = (action: string) =>
    pass.results.filter((result) => result.action === action).length;
  return {
    collected: count('collected'),
    skipped: count('skipped'),
    notDue: count('not-due'),
    failed: pass.failure === undefined ? 0 : 1,
    ...(pass.failure === undefined
      ? {}
      : { failure: `${pass.failure.code}: ${pass.failure.message}` }),
  };
}

interface Step {
  readonly users: number;
  readonly phase: 'load' | 'stress';
  readonly writesSent: number;
  readonly succeeded: number;
  readonly ownFailures: number;
  readonly successRate: number;
  readonly confirmationMs: { p50: number; p95: number; max: number };
  readonly tryAgainLater: number;
  readonly txPerLedger: { average: number; peak: number };
  readonly errors: Readonly<Record<string, number>>;
  readonly reads: number;
  readonly readErrors: number;
  readonly stepSeconds: number;
  readonly keeper?: KeeperFigures;
  readonly broke?: string;
}

/** The topics of a Target Savings `deposited` event, base64. */
const DEPOSITED = ScVal.scvSymbol('deposited').toXdr('base64');

/** Scheduled deposits per goal, from the contract's `deposited` events. */
async function scheduledDeposits(
  contract: string,
  startLedger: number,
): Promise<Map<bigint, number>> {
  const filters = [
    {
      type: 'contract' as const,
      contractIds: [contract],
      topics: [[DEPOSITED, '**']],
    },
  ];
  const counts = new Map<bigint, number>();
  let page = await server.getEvents({ startLedger, filters, limit: 1000 });
  for (;;) {
    for (const event of page.events) {
      const id = event.topic[1];
      const data = scValToNative(event.value) as { kind?: unknown };
      // DepositKind decodes as a one-element list, such as ['Scheduled'].
      const kind: unknown = Array.isArray(data.kind) ? data.kind[0] : data.kind;
      if (id !== undefined && kind === 'Scheduled') {
        const goalId = scValToNative(id) as bigint;
        counts.set(goalId, (counts.get(goalId) ?? 0) + 1);
      }
    }
    const next = await server.getEvents({
      cursor: page.cursor,
      filters,
      limit: 1000,
    });
    if (next.cursor === page.cursor && next.events.length === 0) {
      return counts;
    }
    page = next;
  }
}

it(`runs the load steps ${STEPS.join(', ')} and recovers`, async () => {
  const runStarted = Date.now();
  // The guard in local-only.ts checked this already; check again here.
  expect((await server.getNetwork()).passphrase).toBe(PASSPHRASE);
  expect(STEPS.every((step) => Number.isSafeInteger(step) && step > 0)).toBe(
    true,
  );
  const startLedger = (await server.getLatestLedger()).sequence;

  // Its own contract pair, so no other test shares its totals (W78).
  const pair = await deployInstance(ctx.configDir, ctx.addresses, ctx.token);
  const net: NetworkSettings = {
    ...network(ctx),
    contracts: { targetSavings: pair.targetSavings, spendSave: pair.spendSave },
  };
  const integrator = freshIntegrator();
  const options = { integrator, integratorFeeBps: 0 };
  const reader = createLoktin({ network: net, server });
  const [code, issuer] = ctx.asset.split(':') as [string, string];
  const asset = new Asset(code, issuer);
  const issuerKey = Keypair.fromSecret(
    await stellar(ctx.configDir, ['keys', 'secret', 'issuer']),
  );

  // The keeper's 4 channel accounts.
  const channels = (await fundedAccounts(4, '500')).map((key) =>
    createLoktin({
      network: net,
      server: new Server(ctx.rpcUrl, { allowHttp: true }),
      publicKey: key.publicKey(),
      signer: basicNodeSigner(key, PASSPHRASE),
    }),
  );

  const users: User[] = [];
  /** Adds users until there are `total`: account, TEST, goal and enrolment. */
  const addUsers = async (total: number) => {
    const keys = await fundedAccounts(total - users.length, USER_XLM);
    await inPool(keys, AT_ONCE, (key) =>
      submit(key, [Operation.changeTrust({ asset })]),
    );
    const amount = (Number(USER_TEST) / 1e7).toFixed(7);
    for (const batch of chunks(keys, 100)) {
      await submit(
        issuerKey,
        batch.map((key) =>
          Operation.payment({ destination: key.publicKey(), asset, amount }),
        ),
      );
    }
    const added: User[] = [];
    await inPool(keys, AT_ONCE, async (key) => {
      const sdk: Loktin = createLoktin({
        network: net,
        server,
        publicKey: key.publicKey(),
        signer: basicNodeSigner(key, PASSPHRASE),
      });
      const savings = new TargetSavings(sdk, options);
      const spendSave = new SpendSave(sdk, options);
      // The default allowance covers the goal's scheduled deposits.
      const goal = await savings.createGoal({
        target: toBaseUnits('1000'),
        deadline: new Date(Date.now() + 8 * 3600 * 1000),
        cadenceSeconds: MIN_CADENCE,
        depositSize: DEPOSIT,
        rule: { kind: 'lock' },
      });
      await spendSave.enroll({
        skim: { percentBps: 1000 },
        destination: { kind: 'balance' },
        withdrawalDay: 28,
      });
      added.push({ key, savings, spendSave, goalId: goal.result });
    });
    users.push(...added);
  };

  const pending: { hash: string; validUntil?: Date }[] = [];
  let lastSend = Date.now();
  const steps: Step[] = [];
  let breakingPoint: { users: number; reason: string } | undefined;

  for (const [index, total] of STEPS.entries()) {
    if (breakingPoint !== undefined) {
      // One step past the breaking point, if the time allows, then stop.
      if (
        steps.length > steps.findIndex((s) => s.broke !== undefined) + 1 ||
        Date.now() - runStarted > RUN_BUDGET_MS
      ) {
        break;
      }
    }
    if (total > users.length) {
      await addUsers(total);
    }
    const stress = index >= LOAD_PHASE_STEPS;
    const againBefore = server.tryAgainLater;
    const outcomes: Outcome[] = [];
    let reads = 0;
    let readErrors = 0;
    const stepStarted = Date.now();
    const roundsOf = async (user: User) => {
      for (let round = 0; round < ROUNDS; round++) {
        outcomes.push(
          await timedWrite(() => user.savings.deposit(user.goalId, DEPOSIT)),
        );
        outcomes.push(
          await timedWrite(() =>
            user.spendSave.payAndSave(ctx.addresses.payee, SPEND),
          ),
        );
        lastSend = Date.now();
        try {
          await user.savings.goal(user.goalId);
          reads += 1;
        } catch {
          readErrors += 1;
        }
      }
    };
    const [, keeperPass] = await Promise.all([
      Promise.all(users.slice(0, total).map(roundsOf)),
      stress ? runPass(channels, { integrators: [integrator] }) : undefined,
    ]);
    const stepMs = Date.now() - stepStarted;

    const confirmed = outcomes.filter((o) => o.ledger !== undefined);
    const own = outcomes.filter(
      (o) => o.ledger === undefined && o.own === true,
    );
    for (const o of outcomes) {
      if (o.pending !== undefined) {
        pending.push(o.pending);
      }
    }
    const times = confirmed.map((o) => o.ms).sort((a, b) => a - b);
    const perLedger = new Map<number, number>();
    for (const o of confirmed) {
      perLedger.set(o.ledger ?? 0, (perLedger.get(o.ledger ?? 0) ?? 0) + 1);
    }
    const ledgers = [...perLedger.keys()];
    const span =
      ledgers.length === 0
        ? 0
        : Math.max(...ledgers) - Math.min(...ledgers) + 1;
    const errors: Record<string, number> = {};
    for (const o of outcomes) {
      if (o.code !== undefined) {
        errors[o.code] = (errors[o.code] ?? 0) + 1;
      }
    }
    const counted = outcomes.length - own.length;
    const successRate = counted === 0 ? 1 : confirmed.length / counted;
    const round = (ms: number) => Math.round(ms);
    const p95 = percentile(times, 95);
    const broke =
      successRate < MIN_SUCCESS
        ? `success ${String(Math.round(successRate * 1000) / 10)}% is under 95%`
        : p95 > MAX_P95_MS
          ? `p95 confirmation ${String(round(p95))} ms is over 60 s`
          : stepMs > MAX_STEP_MS
            ? `the step took ${String(Math.round(stepMs / 1000))} s, over 15 minutes`
            : undefined;
    const step: Step = {
      users: total,
      phase: stress ? 'stress' : 'load',
      writesSent: outcomes.length,
      succeeded: confirmed.length,
      ownFailures: own.length,
      successRate: Math.round(successRate * 10_000) / 10_000,
      confirmationMs: {
        p50: round(percentile(times, 50)),
        p95: round(p95),
        max: round(times[times.length - 1] ?? 0),
      },
      tryAgainLater: server.tryAgainLater - againBefore,
      txPerLedger: {
        average:
          span === 0 ? 0 : Math.round((confirmed.length / span) * 100) / 100,
        peak: Math.max(0, ...perLedger.values()),
      },
      errors,
      reads,
      readErrors,
      stepSeconds: Math.round(stepMs / 1000),
      ...(keeperPass === undefined
        ? {}
        : { keeper: keeperFigures(keeperPass) }),
      ...(broke === undefined ? {} : { broke }),
    };
    steps.push(step);
    console.log(JSON.stringify({ step }));
    if (broke !== undefined && breakingPoint === undefined) {
      breakingPoint = { users: total, reason: broke };
    }
  }

  // Recovery. Wait for the time bound of the last transaction to pass.
  await sleep(Math.max(0, lastSend + TIME_BOUND_MS + 5000 - Date.now()));
  let stuck = 0;
  let gone = 0;
  let landed = 0;
  await inPool(pending, AT_ONCE, async ({ hash, validUntil }) => {
    const got = await server.getTransaction(hash);
    if (got.status === Api.GetTransactionStatus.NOT_FOUND) {
      if (validUntil !== undefined && validUntil.getTime() > Date.now()) {
        stuck += 1;
      } else {
        gone += 1;
      }
    } else {
      landed += 1;
    }
  });

  // The keeper catches up once more.
  const catchUp = keeperFigures(
    await runPass(channels, { integrators: [integrator] }),
  );

  // Every recorded balance plus accrued fees equals each contract's tokens.
  const token = (id: string) => reader.read<bigint>('token', 'balance', { id });
  const accrued = async (contract: 'target-savings' | 'spend-save') =>
    (await reader.read<bigint>(contract, 'accrued_fees', {
      recipient: integrator,
    })) +
    (await reader.read<bigint>(contract, 'accrued_fees', {
      recipient: ctx.addresses['fee-recipient'],
    }));
  const scan = await scanGoals(reader, { integrators: [integrator] });
  const goalPrincipals = scan.goals.reduce((sum, g) => sum + g.principal, 0n);
  const balances: bigint[] = [];
  await inPool(users, AT_ONCE, async (user) => {
    balances.push((await user.spendSave.enrollment()).principal);
  });
  const enrolled = balances.reduce((sum, balance) => sum + balance, 0n);
  const totals = {
    targetSavings: {
      tokens: await token(pair.targetSavings),
      recorded: goalPrincipals + (await accrued('target-savings')),
    },
    spendSave: {
      tokens: await token(pair.spendSave),
      recorded: enrolled + (await accrued('spend-save')),
    },
  };

  // No goal collected a period twice: each scheduled deposit event is one
  // collected period, and the collected periods are the last collected one
  // less the missed ones.
  const events = await scheduledDeposits(pair.targetSavings, startLedger);
  const doubled = scan.goals.filter(
    (g) =>
      (events.get(g.id) ?? 0) !== Number(g.lastCollectedPeriod - g.missedCount),
  ).length;

  const recovery = {
    pendingHashes: pending.length,
    landed,
    gone,
    stuck,
    keeperCatchUp: catchUp,
    totals: {
      targetSavings: {
        tokens: totals.targetSavings.tokens.toString(),
        recorded: totals.targetSavings.recorded.toString(),
      },
      spendSave: {
        tokens: totals.spendSave.tokens.toString(),
        recorded: totals.spendSave.recorded.toString(),
      },
    },
    goalsChecked: scan.goals.length,
    goalsCollectedTwice: doubled,
    scheduledDeposits: [...events.values()].reduce((a, b) => a + b, 0),
  };

  const sdkVersion = (
    JSON.parse(
      await readFile(join(process.cwd(), 'packages/sdk/package.json'), 'utf8'),
    ) as { version: string }
  ).version;
  const results = {
    date: new Date(runStarted).toISOString(),
    commit: await commit(),
    sdkVersion,
    machine: {
      cpus: cpus().length,
      memoryGiB: Math.round(totalmem() / 2 ** 30),
    },
    network:
      'private local network (stellar/quickstart, --limits testnet, protocol 29)',
    steps: STEPS,
    rules: {
      minSuccessRate: MIN_SUCCESS,
      maxP95Ms: MAX_P95_MS,
      maxStepMs: MAX_STEP_MS,
    },
    results: steps,
    breakingPoint: breakingPoint ?? {
      aboveTopStep: steps[steps.length - 1]?.users ?? 0,
    },
    recovery,
    runSeconds: Math.round((Date.now() - runStarted) / 1000),
  };
  const output = process.env['LOAD_OUTPUT'];
  if (output !== undefined && output !== '') {
    await writeFile(
      join(output, 'load-test.json'),
      `${JSON.stringify(results, null, 2)}\n`,
    );
  }
  console.log(
    [
      '| Users | Phase | Writes | Success | Own failures | p50 (ms) | p95 (ms) | Max (ms) | TRY_AGAIN_LATER | Tx per ledger (avg / peak) | Keeper (collected / skipped / failed) | Step (s) |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|',
      ...steps.map(
        (s) =>
          `| ${String(s.users)} | ${s.phase} | ${String(s.writesSent)} | ${String(Math.round(s.successRate * 1000) / 10)}% | ${String(s.ownFailures)} | ${String(s.confirmationMs.p50)} | ${String(s.confirmationMs.p95)} | ${String(s.confirmationMs.max)} | ${String(s.tryAgainLater)} | ${String(s.txPerLedger.average)} / ${String(s.txPerLedger.peak)} | ${s.keeper === undefined ? '-' : `${String(s.keeper.collected)} / ${String(s.keeper.skipped)} / ${String(s.keeper.failed)}`} | ${String(s.stepSeconds)} |`,
      ),
    ].join('\n'),
  );
  console.log(
    JSON.stringify({ breakingPoint: results.breakingPoint, recovery }),
  );

  // A broken invariant fails the run, whatever the load did.
  expect(stuck).toBe(0);
  expect(totals.targetSavings.tokens).toBe(totals.targetSavings.recorded);
  expect(totals.spendSave.tokens).toBe(totals.spendSave.recorded);
  expect(doubled).toBe(0);
  expect(catchUp.failed).toBe(0);
  expect(scan.goals).toHaveLength(users.length);
});
