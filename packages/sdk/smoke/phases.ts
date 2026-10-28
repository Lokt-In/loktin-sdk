// The phases of the testnet smoke script (V6, W85 to W89). Each takes a
// context, so a reviewer can run it on a local network with throwaway keys
// by building their own context instead of the testnet one.
import { Api, Server } from '@stellar/stellar-sdk/rpc';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  ContractError,
  LoktinError,
  type NetworkSettings,
  PendingError,
  TokenError,
  TransactionFailedError,
  type WriteResult,
  createLoktin,
} from '@loktin/sdk';
import { type EnrollInput, SpendSave } from '@loktin/sdk/spend-save';
import { type Goal, TargetSavings } from '@loktin/sdk/target-savings';
import {
  DAY,
  type EvidenceGoalSpec,
  type Evidence,
  type Funding,
  type Phase,
  ROLES,
  type Role,
  TARGETS,
  USDC,
  type User,
  findEvidenceGoal,
  phaseBudget,
  preflightProblems,
  stepRecord,
  summarise,
  tidyUpPlan,
  toJson,
} from './helpers.ts';
import type { TimedSigner } from './signer.ts';

/** Everything a phase needs, built by the caller (W82). */
export interface SmokeContext {
  readonly network: NetworkSettings;
  /** The signer for an alias. */
  readonly signerFor: (alias: string) => TimedSigner;
  readonly aliases: Readonly<Record<Role, string>>;
  readonly addresses: Readonly<Record<Role, string>>;
  readonly evidencePath: string;
  readonly clock: {
    now(): Date;
    sleep(ms: number): Promise<void>;
  };
  readonly sdkVersion: string;
  readonly commit: string;
  readonly log: (line: string) => void;
}

/** Integrator A charges 0.5%, integrator B 1% (W84). */
const FEE_BPS: Readonly<Record<'integratorA' | 'integratorB', number>> = {
  integratorA: 50,
  integratorB: 100,
};

const units = (amount: string): bigint => {
  const [whole = '0', fraction = ''] = amount.split('.');
  return BigInt(whole) * USDC + BigInt(fraction.padEnd(7, '0').slice(0, 7));
};

/** The two evidence goals the keeper collects (W87). */
function evidenceSpecs(
  addresses: Readonly<Record<Role, string>>,
): Readonly<Record<User, EvidenceGoalSpec>> {
  const common = {
    target: 5n * USDC,
    depositSize: 1n * USDC,
    cadenceSeconds: DAY,
  };
  return {
    userA: {
      ...common,
      integrator: addresses.integratorA,
      rule: { kind: 'penalty', bps: 500 },
    },
    userB: {
      ...common,
      integrator: addresses.integratorB,
      rule: { kind: 'lock' },
    },
  };
}

/** The SDK instances and modules of one run. */
class Actors {
  readonly signers: Readonly<Record<Role, TimedSigner>>;
  private readonly ctx: SmokeContext;
  private readonly instances = new Map<Role, ReturnType<typeof createLoktin>>();

  constructor(ctx: SmokeContext) {
    this.ctx = ctx;
    const signers = {} as Record<Role, TimedSigner>;
    for (const role of ROLES) {
      signers[role] = ctx.signerFor(ctx.aliases[role]);
    }
    this.signers = signers;
  }

  private loktin(role: Role): ReturnType<typeof createLoktin> {
    let instance = this.instances.get(role);
    if (instance === undefined) {
      instance = createLoktin({
        network: this.ctx.network,
        publicKey: this.ctx.addresses[role],
        signer: { signTransaction: this.signers[role].signTransaction },
      });
      this.instances.set(role, instance);
    }
    return instance;
  }

  /** Target Savings for `role`, through `integrator`. */
  savings(
    role: Role,
    integrator: 'integratorA' | 'integratorB',
  ): TargetSavings {
    return new TargetSavings(this.loktin(role), {
      integrator: this.ctx.addresses[integrator],
      integratorFeeBps: FEE_BPS[integrator],
    });
  }

  /** Spend & Save for `role`, through `integrator`. */
  spendSave(role: Role, integrator: 'integratorA' | 'integratorB'): SpendSave {
    return new SpendSave(this.loktin(role), {
      integrator: this.ctx.addresses[integrator],
      integratorFeeBps: FEE_BPS[integrator],
    });
  }

  /** Reads need no signer; the user's own instance serves them. */
  reader(): ReturnType<typeof createLoktin> {
    return this.loktin('userA');
  }
}

/** Writes the evidence file after every step (W89). */
class Recorder {
  readonly evidence: Evidence;
  private readonly ctx: SmokeContext;
  private readonly actors: Actors;
  private readonly server: Server;

  constructor(ctx: SmokeContext, actors: Actors, phase: Phase) {
    this.ctx = ctx;
    this.actors = actors;
    this.server = new Server(ctx.network.rpcUrl, {
      allowHttp: ctx.network.rpcUrl.startsWith('http://'),
    });
    this.evidence = {
      phase,
      network: {
        passphrase: ctx.network.passphrase,
        rpcUrl: ctx.network.rpcUrl,
        targetSavings: ctx.network.contracts.targetSavings,
        spendSave: ctx.network.contracts.spendSave,
        token: ctx.network.token,
      },
      sdkVersion: ctx.sdkVersion,
      commit: ctx.commit,
      startedAt: ctx.clock.now().toISOString(),
      endedAt: null,
      complete: false,
      aliases: ROLES.map((role) => ({
        role,
        alias: ctx.aliases[role],
        address: ctx.addresses[role],
      })),
      steps: [],
      refusals: [],
      checks: [],
      skipped: [],
    };
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.ctx.evidencePath), { recursive: true });
    await writeFile(this.ctx.evidencePath, toJson(this.evidence));
  }

  // The fee charged, from the confirmed transaction. A failed read records
  // no fee rather than stopping the phase.
  private async feeOf(hash: string): Promise<bigint | undefined> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const tx = await this.server.getTransaction(hash);
        if (tx.status === Api.GetTransactionStatus.SUCCESS) {
          return tx.resultXdr.feeCharged;
        }
      } catch {
        // Tried again below.
      }
      await this.ctx.clock.sleep(1000);
    }
    return undefined;
  }

  /** Runs one write and records it. Returns its result and its write time. */
  async write<R extends WriteResult<unknown>>(
    label: string,
    call: string,
    actor: Role,
    run: () => Promise<R>,
  ): Promise<{ result: R; timeMs: number }> {
    const signer = this.actors.signers[actor];
    const signedBefore = signer.signingMs();
    const started = performance.now();
    const result = await run();
    const totalMs = performance.now() - started;
    const signingMs = signer.signingMs() - signedBefore;
    const fee = await this.feeOf(result.hash);
    const step = stepRecord({
      label,
      call,
      actor: this.ctx.aliases[actor],
      hash: result.hash,
      ledger: result.ledger,
      feeCharged: fee ?? -1n,
      totalMs,
      signingMs,
    });
    this.evidence.steps.push(
      fee === undefined ? { ...step, feeCharged: 'unknown' } : step,
    );
    await this.save();
    this.ctx.log(`${label}: ${result.hash}`);
    return { result, timeMs: step.timeMs };
  }

  /** Runs a call that must be refused with `errorName`, and records it. */
  async refusal(
    label: string,
    errorName: string,
    run: () => Promise<unknown>,
  ): Promise<void> {
    let outcome: unknown;
    try {
      await run();
    } catch (error) {
      outcome = error;
    }
    if (
      outcome instanceof LoktinError &&
      'errorName' in outcome &&
      outcome.errorName === errorName
    ) {
      this.evidence.refusals.push({ label, code: outcome.code, errorName });
      await this.save();
      this.ctx.log(`${label}: refused with ${errorName}, as expected`);
      return;
    }
    if (outcome === undefined) {
      throw new Error(
        `${label}: expected ${errorName}, but the call succeeded`,
      );
    }
    throw outcome instanceof Error
      ? outcome
      : new Error(`${label}: failed with a non-error value`);
  }

  async check(label: string, passed: boolean, detail: string): Promise<void> {
    this.evidence.checks.push({ label, passed, detail });
    await this.save();
    this.ctx.log(`${label}: ${passed ? 'passed' : 'FAILED'} (${detail})`);
  }

  async skip(label: string, reason: string): Promise<void> {
    this.evidence.skipped.push({ label, reason });
    await this.save();
    this.ctx.log(`${label}: skipped, ${reason}`);
  }

  async fail(error: unknown): Promise<void> {
    const hash =
      error instanceof PendingError || error instanceof TransactionFailedError
        ? error.hash
        : undefined;
    this.evidence.error = {
      code: error instanceof LoktinError ? error.code : 'UNEXPECTED',
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      ...(hash === undefined ? {} : { hash }),
    };
    this.evidence.endedAt = this.ctx.clock.now().toISOString();
    await this.save();
  }

  async finish(): Promise<void> {
    this.evidence.endedAt = this.ctx.clock.now().toISOString();
    this.evidence.complete = true;
    await this.save();
  }
}

/** Reads every alias's funding and stops before any write if anything is short. */
async function preflight(
  ctx: SmokeContext,
  actors: Actors,
  phase: Phase,
): Promise<string[]> {
  const server = new Server(ctx.network.rpcUrl, {
    allowHttp: ctx.network.rpcUrl.startsWith('http://'),
  });
  const reader = actors.reader();
  const funding: Funding[] = [];
  for (const role of ROLES) {
    const address = ctx.addresses[role];
    let xlm: bigint | undefined;
    try {
      xlm = (await server.getAccountEntry(address)).balance;
    } catch {
      xlm = undefined;
    }
    let usdc: bigint | undefined;
    try {
      usdc = await reader.read<bigint>('token', 'balance', { id: address });
    } catch (error) {
      // TrustlineMissing (13): the address cannot hold USDC.
      if (!(error instanceof TokenError && error.number === 13)) {
        throw error;
      }
    }
    funding.push({ role, alias: ctx.aliases[role], xlm, usdc });
  }
  return preflightProblems(funding, phaseBudget(phase));
}

/** Runs a phase and writes its evidence. Returns false if it stopped early. */
export async function runPhase(
  phase: Phase,
  ctx: SmokeContext,
): Promise<boolean> {
  if (phase === 'window' && ctx.clock.now().getUTCDate() !== 1) {
    ctx.log(
      'The window phase runs only on day 1 of a month (UTC), the withdrawal day of the enrolments.',
    );
    return false;
  }
  const actors = new Actors(ctx);
  const problems = await preflight(ctx, actors, phase);
  if (problems.length > 0) {
    ctx.log('Stopped before any write. Short:');
    for (const problem of problems) {
      ctx.log(`  ${problem}`);
    }
    return false;
  }
  if (phase === 'run') {
    // W92: the run needs both evidence goals, and stops before any write
    // without them, as the funding preflight does.
    const specs = evidenceSpecs(ctx.addresses);
    const missing: string[] = [];
    for (const user of ['userA', 'userB'] as const) {
      const savings = actors.savings(
        user,
        user === 'userA' ? 'integratorA' : 'integratorB',
      );
      const { evidence } = tidyUpPlan(
        await savings.userGoals(),
        specs[user],
        ctx.clock.now(),
      );
      if (evidence === undefined) {
        missing.push(user);
      }
    }
    if (missing.length > 0) {
      ctx.log(
        `Stopped before any write: no open evidence goal for ${missing.join(' and ')}. Run the goals phase first.`,
      );
      return false;
    }
  }
  const recorder = new Recorder(ctx, actors, phase);
  await recorder.save();
  try {
    switch (phase) {
      case 'goals':
        await goalsPhase(ctx, actors, recorder);
        break;
      case 'run':
        await runFlows(ctx, actors, recorder);
        break;
      case 'window':
        await windowPhase(actors, recorder);
        break;
    }
  } catch (error) {
    await recorder.fail(error);
    ctx.log(
      `Stopped: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (error instanceof PendingError) {
      ctx.log(
        `Transaction ${error.hash} may still land. It was not sent again.`,
      );
    }
    return false;
  }
  await recorder.finish();
  ctx.log(`Done. Evidence: ${ctx.evidencePath}`);
  return true;
}

/** The two evidence goals (W87). An open matching goal is reused. */
async function goalsPhase(
  ctx: SmokeContext,
  actors: Actors,
  recorder: Recorder,
): Promise<void> {
  const specs = evidenceSpecs(ctx.addresses);
  const goals: NonNullable<Evidence['goals']> = [];
  recorder.evidence.goals = goals;
  for (const user of ['userA', 'userB'] as const) {
    const spec = specs[user];
    const integrator = user === 'userA' ? 'integratorA' : 'integratorB';
    const savings = actors.savings(user, integrator);
    const existing = findEvidenceGoal(await savings.userGoals(), spec);
    if (existing !== undefined) {
      goals.push({
        user,
        id: existing.id.toString(),
        created: false,
        hash: null,
        allowance: null,
        expiryLedger: null,
        renewBy: null,
      });
      await recorder.skip(
        `${user} evidence goal`,
        `open goal ${existing.id.toString()} already matches`,
      );
      continue;
    }
    // 7 days and a 1-hour margin, so the goal keeps all 7 periods (W102).
    const deadline = new Date(
      ctx.clock.now().getTime() + (7 * DAY + 3600) * 1000,
    );
    const { result } = await recorder.write(
      `${user} creates the evidence goal`,
      'targetSavings.createGoal',
      user,
      () =>
        savings.createGoal({
          target: spec.target,
          deadline,
          cadenceSeconds: spec.cadenceSeconds,
          depositSize: spec.depositSize,
          rule: spec.rule,
          allowance: 'auto',
        }),
    );
    goals.push({
      user,
      id: result.result.toString(),
      created: true,
      hash: result.hash,
      allowance: result.allowance?.amount.toString() ?? null,
      expiryLedger: result.allowance?.expiryLedger ?? null,
      renewBy: result.allowance?.renewBy?.toISOString() ?? null,
    });
    await recorder.save();
  }
}

/** A goal for the flows: daily, a 2-day deadline, approving nothing (W85). */
function flowGoal(
  ctx: SmokeContext,
  target: string,
  depositSize: string,
  rule: Goal['rule'],
) {
  return {
    target: units(target),
    deadline: new Date(ctx.clock.now().getTime() + 2 * DAY * 1000),
    cadenceSeconds: DAY,
    depositSize: units(depositSize),
    rule,
    allowance: 'none' as const,
  };
}

/**
 * Enrols user A, or, when an earlier run already did, updates the
 * enrolment with the same settings (W92). With the same withdrawal day,
 * no day change is made.
 */
async function enrolOrUpdate(
  recorder: Recorder,
  label: string,
  spendSave: SpendSave,
  input: EnrollInput,
): Promise<void> {
  let enrolled = true;
  try {
    await spendSave.enrollment();
  } catch (error) {
    if (!(
      error instanceof ContractError && error.errorName === 'EnrollmentNotFound'
    )) {
      throw error;
    }
    enrolled = false;
  }
  if (enrolled) {
    await recorder.write(
      `${label} (already enrolled: updates its settings)`,
      'spendSave.updateSettings',
      'userA',
      () => spendSave.updateSettings(input),
    );
  } else {
    await recorder.write(label, 'spendSave.enroll', 'userA', () =>
      spendSave.enroll(input),
    );
  }
}

/** The flows and the latency sample (W85, W88). */
async function runFlows(
  ctx: SmokeContext,
  actors: Actors,
  recorder: Recorder,
): Promise<void> {
  const own = {
    userA: actors.savings('userA', 'integratorA'),
    userB: actors.savings('userB', 'integratorB'),
  } as const;

  // W92: close every goal but the evidence goals that an earlier stopped
  // run left open, so a rerun starts from the same place.
  const specs = evidenceSpecs(ctx.addresses);
  for (const user of ['userA', 'userB'] as const) {
    const { actions } = tidyUpPlan(
      await own[user].userGoals(),
      specs[user],
      ctx.clock.now(),
    );
    for (const action of actions) {
      const id = action.goalId.toString();
      if (action.kind === 'fill-then-withdraw') {
        await recorder.write(
          `tidy-up: ${user} fills lock goal ${id} to its target`,
          'targetSavings.deposit',
          user,
          () => own[user].deposit(action.goalId, action.amount),
        );
      }
      const why = action.kind === 'withdraw' ? action.reason : 'at its target';
      await recorder.write(
        `tidy-up: ${user} withdraws goal ${id} (${why})`,
        'targetSavings.withdraw',
        user,
        () => own[user].withdraw(action.goalId),
      );
    }
  }

  // Penalty goals: deposit, a refused deposit by the other user, then an
  // early withdrawal that accrues the penalty to the integrator.
  const penaltyGoals = {} as Record<User, bigint>;
  for (const user of ['userA', 'userB'] as const) {
    const { result } = await recorder.write(
      `${user} creates a penalty goal`,
      'targetSavings.createGoal',
      user,
      () =>
        own[user].createGoal(
          flowGoal(ctx, '2', '1', { kind: 'penalty', bps: 1000 }),
        ),
    );
    penaltyGoals[user] = result.result;
    await recorder.write(
      `${user} deposits into the penalty goal`,
      'targetSavings.deposit',
      user,
      () => own[user].deposit(result.result, units('1')),
    );
  }
  await recorder.refusal(
    "userB deposits into userA's penalty goal",
    'NotOwner',
    () => own.userB.deposit(penaltyGoals.userA, units('0.01')),
  );
  for (const user of ['userA', 'userB'] as const) {
    await recorder.write(
      `${user} withdraws the penalty goal early`,
      'targetSavings.withdraw',
      user,
      () => own[user].withdraw(penaltyGoals[user]),
    );
  }

  // Lock goals: refused until the target is reached.
  for (const user of ['userA', 'userB'] as const) {
    const { result } = await recorder.write(
      `${user} creates a lock goal`,
      'targetSavings.createGoal',
      user,
      () => own[user].createGoal(flowGoal(ctx, '1', '1', { kind: 'lock' })),
    );
    const id = result.result;
    await recorder.write(
      `${user} deposits half of the lock goal`,
      'targetSavings.deposit',
      user,
      () => own[user].deposit(id, units('0.5')),
    );
    await recorder.refusal(
      `${user} withdraws the lock goal before its target`,
      'Locked',
      () => own[user].withdraw(id),
    );
    await recorder.write(
      `${user} deposits the rest of the lock goal`,
      'targetSavings.deposit',
      user,
      () => own[user].deposit(id, units('0.5')),
    );
    await recorder.write(
      `${user} withdraws the lock goal at its target`,
      'targetSavings.withdraw',
      user,
      () => own[user].withdraw(id),
    );
  }

  // Spend & Save for user A, with integrator A, to the balance.
  const spendSaveA = actors.spendSave('userA', 'integratorA');
  await enrolOrUpdate(recorder, 'userA enrols with integratorA', spendSaveA, {
    skim: { percentBps: 500, roundUpUnit: USDC },
    destination: { kind: 'balance' },
    withdrawalDay: 1,
  });
  await recorder.write(
    'userA pays userB and saves the skim',
    'spendSave.payAndSave',
    'userA',
    () => spendSaveA.payAndSave(ctx.addresses.userB, units('1.25')),
  );
  await recorder.write(
    'userA saves for a spend',
    'spendSave.saveForSpend',
    'userA',
    () => spendSaveA.saveForSpend(units('2')),
  );
  if (ctx.clock.now().getUTCDate() === 1) {
    await recorder.skip(
      'userA withdraws outside the window',
      'today is the withdrawal day (UTC day 1), so the window is open',
    );
  } else {
    await recorder.refusal(
      'userA withdraws outside the window',
      'OutsideWindow',
      () => spendSaveA.withdraw(units('0.1')),
    );
  }

  // Spend & Save for user A, with integrator B, into a goal that then closes.
  const savingsAB = actors.savings('userA', 'integratorB');
  const spendSaveAB = actors.spendSave('userA', 'integratorB');
  const { result: skimGoal } = await recorder.write(
    'userA creates the skim goal',
    'targetSavings.createGoal',
    'userA',
    () =>
      savingsAB.createGoal(
        flowGoal(ctx, '3', '1', { kind: 'penalty', bps: 500 }),
      ),
  );
  await enrolOrUpdate(
    recorder,
    'userA enrols with integratorB into the skim goal',
    spendSaveAB,
    {
      skim: { percentBps: 1000 },
      destination: { kind: 'goal', goalId: skimGoal.result },
      withdrawalDay: 1,
    },
  );
  const { result: saved } = await recorder.write(
    'userA saves for a spend into the skim goal',
    'spendSave.saveForSpend',
    'userA',
    () => spendSaveAB.saveForSpend(units('2')),
  );
  await recorder.check(
    'the skim went into the goal',
    saved.result.toGoal === units('0.2') && saved.result.toBalance === 0n,
    `toGoal ${saved.result.toGoal.toString()}, toBalance ${saved.result.toBalance.toString()}`,
  );
  await recorder.write(
    'userA withdraws the skim goal early',
    'targetSavings.withdraw',
    'userA',
    () => savingsAB.withdraw(skimGoal.result),
  );

  // Each integrator claims its Target Savings fees.
  for (const integrator of ['integratorA', 'integratorB'] as const) {
    const savings = actors.savings(integrator, integrator);
    const owed = await savings.accruedFees();
    if (owed > 0n) {
      await recorder.write(
        `${integrator} claims its Target Savings fees`,
        'targetSavings.claimFees',
        integrator,
        () => savings.claimFees(),
      );
    } else {
      await recorder.skip(
        `${integrator} claims its Target Savings fees`,
        'nothing accrued',
      );
    }
  }

  // Latency sample, writes (W88): 25 deposits of 0.01 per user, alternating.
  const spare = {} as Record<User, bigint>;
  for (const user of ['userA', 'userB'] as const) {
    const { result } = await recorder.write(
      `${user} creates the spare goal`,
      'targetSavings.createGoal',
      user,
      () =>
        own[user].createGoal(flowGoal(ctx, '0.25', '0.25', { kind: 'lock' })),
    );
    spare[user] = result.result;
  }
  const writeTimes: number[] = [];
  for (let index = 0; index < 50; index++) {
    const user = index % 2 === 0 ? 'userA' : 'userB';
    const { timeMs } = await recorder.write(
      `sample write ${String(index + 1)}: ${user} deposits 0.01`,
      'targetSavings.deposit',
      user,
      () => own[user].deposit(spare[user], units('0.01')),
    );
    writeTimes.push(timeMs);
  }
  for (const user of ['userA', 'userB'] as const) {
    await recorder.write(
      `${user} withdraws the spare goal at its target`,
      'targetSavings.withdraw',
      user,
      () => own[user].withdraw(spare[user]),
    );
  }

  // Latency sample, reads (W88): 300, one after another, 200 ms apart.
  const evidenceA = findEvidenceGoal(await own.userA.userGoals(), specs.userA);
  if (evidenceA === undefined) {
    throw new Error(
      "userA's evidence goal is missing: run the goals phase first",
    );
  }
  const integratorSavings = actors.savings('integratorA', 'integratorA');
  const reads: (() => Promise<unknown>)[] = [
    () => own.userA.goal(evidenceA.id),
    () => own.userA.userGoals(),
    () => integratorSavings.accruedFees(),
    () => own.userA.previewWithdraw(evidenceA.id),
    () => own.userA.minCadence(),
    () => spendSaveA.enrollment(),
    () => spendSaveA.nextWindow(),
  ];
  const readTimes: number[] = [];
  for (let index = 0; index < 300; index++) {
    const read = reads[index % reads.length];
    if (read === undefined) throw new Error('no read');
    const started = performance.now();
    await read();
    readTimes.push(Math.round(performance.now() - started));
    await ctx.clock.sleep(200);
  }
  const readSummary = summarise(readTimes);
  const writeSummary = summarise(writeTimes);
  recorder.evidence.latency = {
    reads: readSummary,
    writes: writeSummary,
    targets: TARGETS,
    readsMeetTarget: readSummary.p95Ms < TARGETS.readP95Ms,
    writesMeetTarget: writeSummary.p95Ms < TARGETS.writeP95Ms,
  };
  await recorder.save();
  ctx.log(
    `latency: reads p95 ${String(readSummary.p95Ms)} ms, writes p95 ${String(writeSummary.p95Ms)} ms`,
  );

  // Last, a read-only check: each user's only open goal is its evidence
  // goal, and its allowance still covers the next collection.
  for (const user of ['userA', 'userB'] as const) {
    const open = await own[user].userGoals();
    const evidence = findEvidenceGoal(open, specs[user]);
    const status =
      evidence === undefined
        ? undefined
        : await own[user].allowanceStatus(evidence.id);
    await recorder.check(
      `${user}'s only open goal is its evidence goal, and its allowance is not short`,
      open.length === 1 && evidence !== undefined && status?.short === false,
      `${String(open.length)} open goal(s); allowance ${status?.allowance.toString() ?? 'none'}, next ${status?.nextAmount.toString() ?? 'none'}`,
    );
  }
}

/** On 1 November UTC: empty and close both enrolments, then claim (W86). */
async function windowPhase(actors: Actors, recorder: Recorder): Promise<void> {
  const spendSaveA = actors.spendSave('userA', 'integratorA');
  const spendSaveAB = actors.spendSave('userA', 'integratorB');
  const { principal } = await spendSaveA.enrollment();
  if (principal > 0n) {
    await recorder.write(
      'userA withdraws the integratorA balance',
      'spendSave.withdraw',
      'userA',
      () => spendSaveA.withdraw(principal),
    );
  }
  await recorder.write(
    'userA closes the integratorA enrolment',
    'spendSave.close',
    'userA',
    () => spendSaveA.close(),
  );
  const { principal: principalB } = await spendSaveAB.enrollment();
  if (principalB > 0n) {
    await recorder.write(
      'userA withdraws the integratorB balance',
      'spendSave.withdraw',
      'userA',
      () => spendSaveAB.withdraw(principalB),
    );
  }
  await recorder.write(
    'userA closes the integratorB enrolment',
    'spendSave.close',
    'userA',
    () => spendSaveAB.close(),
  );
  for (const integrator of ['integratorA', 'integratorB'] as const) {
    const spendSave = actors.spendSave(integrator, integrator);
    const owed = await spendSave.accruedFees();
    if (owed > 0n) {
      await recorder.write(
        `${integrator} claims its Spend & Save fees`,
        'spendSave.claimFees',
        integrator,
        () => spendSave.claimFees(),
      );
    } else {
      await recorder.skip(
        `${integrator} claims its Spend & Save fees`,
        'nothing accrued',
      );
    }
  }
}
