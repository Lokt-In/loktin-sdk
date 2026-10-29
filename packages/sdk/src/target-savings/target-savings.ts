import type { IntegratorOptions } from '../config.js';
import { InvalidInputError } from '../errors.js';
import type { Loktin, WriteResult } from '../loktin.js';
import {
  checkAddress,
  checkBigInt,
  checkDate,
  checkIntegrator,
  checkPositive,
  checkU32,
  checkU64,
  secondsOf,
  userOf,
  writerOf,
} from '../validate.js';
import {
  type ScheduledAllowance,
  combineAllowances,
  scheduledAllowance,
} from './allowance.js';
import {
  type Goal,
  type GoalWithdrawal,
  type RawGoal,
  type RawWithdrawal,
  type TargetSavingsReadAdapter,
  type WithdrawalRule,
  checkRule,
  toGoal,
  toGoalWithdrawal,
  toRawRule,
} from './types.js';

/**
 * The allowance a new goal approves for its scheduled deposits. An owner has
 * one token allowance for Target Savings, shared by all their goals, and an
 * approval replaces it whole.
 * - `'auto'` approves what all the owner's open goals need, the new one
 *   included: each worked out with {@link scheduledAllowance}, then
 *   combined with {@link combineAllowances}.
 * - `'none'` approves nothing and leaves the current allowance as it is.
 * - An object approves exactly that, and replaces the allowance of all the
 *   owner's goals.
 *
 * Goals are best created one at a time, so each `'auto'` approval sees the
 * goals before it.
 */
export type GoalAllowance =
  'auto' | 'none' | { readonly amount: bigint; readonly expiryLedger: number };

/** The inputs of {@link TargetSavings.createGoal}. */
export interface CreateGoalInput {
  readonly target: bigint;
  readonly deadline: Date;
  readonly cadenceSeconds: number;
  readonly depositSize: bigint;
  readonly rule: WithdrawalRule;
  /** Defaults to `'auto'`. */
  readonly allowance?: GoalAllowance;
}

/** The outcome of {@link TargetSavings.createGoal}. `result` is the new goal id. */
export interface CreatedGoal extends WriteResult<bigint> {
  /** The combined allowance approved for `'auto'`, otherwise undefined. */
  readonly allowance: ScheduledAllowance | undefined;
}

/** The outcome of {@link TargetSavings.renewAllowance}. */
export interface RenewedAllowance extends WriteResult<null> {
  /** The allowance approved, for all the owner's open goals. */
  readonly allowance: ScheduledAllowance;
}

/** What {@link TargetSavings.allowanceStatus} reports. */
export interface AllowanceStatus {
  /** What Target Savings may still collect from the owner. */
  readonly allowance: bigint;
  /** The amount the next collection takes, or 0 when no collection is left. */
  readonly nextAmount: bigint;
  /** True when the next collection would fail for lack of allowance. */
  readonly short: boolean;
}

/**
 * Target Savings for the configured `publicKey`, with one integrator. Every
 * write acts for `publicKey`, and every check that needs no chain data runs
 * before any network call.
 */
export class TargetSavings {
  /** The integrator's address. */
  readonly integrator: string;
  /** The integrator fee new goals receive. */
  readonly integratorFeeBps: number;
  private readonly loktin: Loktin;
  private readonly contractId: string;
  private readonly chain: Required<TargetSavingsReadAdapter>;

  /** Checks the options, with no network call. */
  constructor(loktin: Loktin, options: IntegratorOptions) {
    this.loktin = loktin;
    this.contractId = loktin.config.contracts.targetSavings;
    ({ integrator: this.integrator, integratorFeeBps: this.integratorFeeBps } =
      checkIntegrator(options, this.contractId));
    this.chain = chainReads(loktin);
  }

  private get adapter(): TargetSavingsReadAdapter | undefined {
    return this.loktin.config.readAdapter?.targetSavings;
  }

  /**
   * Creates a goal for `publicKey` and returns its id. Ids are not
   * sequential: each comes from the owner and its own counter. With
   * `'auto'`, the allowance covers the scheduled deposits of all the owner's
   * open goals and the new one, because an approval replaces the owner's
   * whole Target Savings allowance (W116). It reads the owner's open goals
   * and the ledger in parallel before the write. The returned allowance is
   * the combined one. The deadline is rounded down to the second.
   */
  async createGoal(input: CreateGoalInput): Promise<CreatedGoal> {
    const owner = writerOf(this.loktin.config);
    // The contract's own order (W59).
    const target = checkPositive(input.target, 'target', 'InvalidTarget');
    const depositSize = checkPositive(
      input.depositSize,
      'depositSize',
      'InvalidDeposit',
    );
    const deadline = checkDate(input.deadline, 'deadline');
    const now = new Date();
    if (secondsOf(deadline) <= secondsOf(now)) {
      throw new InvalidInputError(
        'deadline must be in the future (InvalidDeadline)',
      );
    }
    const cadence = input.cadenceSeconds;
    if (!Number.isSafeInteger(cadence) || cadence < 0) {
      throw new InvalidInputError(
        'cadenceSeconds must be a whole number of seconds',
      );
    }
    if (secondsOf(now) + cadence > secondsOf(deadline)) {
      throw new InvalidInputError(
        'the first deposit must fall due by the deadline (NoPeriodBeforeDeadline)',
      );
    }
    const rule = checkRule(input.rule);
    // The integrator and its fee were checked when the module was created.

    let allowance: ScheduledAllowance | undefined;
    let approval: [bigint, number] | undefined;
    // Checked at run time too, for callers without types.
    const choice: unknown = input.allowance ?? 'auto';
    if (choice === 'auto') {
      const [open, { latestLedger, maxEntryTtl }] = await Promise.all([
        this.chain.userGoals(owner),
        this.loktin.ledgerInfo(),
      ]);
      const ledger = { now, ledger: latestLedger, maxEntryTtl };
      allowance = combineAllowances([
        ...open.map((goal) => allowanceOf(goal, ledger)),
        scheduledAllowance({
          ...ledger,
          start: now,
          deadline,
          cadenceSeconds: cadence,
          depositSize,
          target,
          principal: 0n,
          lastCollectedPeriod: 0n,
        }),
      ]);
      approval = [allowance.amount, allowance.expiryLedger];
    } else if (typeof choice === 'object' && choice !== null) {
      const { amount, expiryLedger } = choice as Record<string, unknown>;
      approval = [
        checkBigInt(amount, 'allowance.amount'),
        checkU32(expiryLedger, 'allowance.expiryLedger'),
      ];
    } else if (choice !== 'none') {
      throw new InvalidInputError(
        "allowance must be 'auto', 'none' or { amount, expiryLedger }",
      );
    }

    const created = await this.loktin.write<bigint>(
      'target-savings',
      'create_goal',
      {
        owner,
        target,
        deadline: BigInt(secondsOf(deadline)),
        cadence: BigInt(cadence),
        deposit_size: depositSize,
        rule: toRawRule(rule),
        integrator: this.integrator,
        integrator_fee_bps: this.integratorFeeBps,
        allowance: approval,
      },
    );
    return { ...created, allowance };
  }

  /** Deposits `amount` from `publicKey` into their goal (P7). */
  async deposit(goalId: bigint, amount: bigint): Promise<WriteResult<null>> {
    const owner = writerOf(this.loktin.config);
    const goal_id = checkU64(goalId, 'goalId');
    checkPositive(amount, 'amount', 'InvalidDeposit');
    return this.loktin.write('target-savings', 'deposit', {
      owner,
      goal_id,
      amount,
    });
  }

  /**
   * Withdraws the whole goal of `publicKey` and closes it (P5, P6, R2).
   * The owner receives `toUser`. The penalty and integrator fee accrue to
   * the integrator, and the Loktin fee to Loktin's fee recipient, who each
   * claim them with {@link TargetSavings.claimFees}.
   */
  async withdraw(goalId: bigint): Promise<WriteResult<GoalWithdrawal>> {
    const owner = writerOf(this.loktin.config);
    const goal_id = checkU64(goalId, 'goalId');
    const written = await this.loktin.write<RawWithdrawal>(
      'target-savings',
      'withdraw',
      { owner, goal_id },
    );
    return { ...written, result: toGoalWithdrawal(written.result) };
  }

  /** Collects the deposit for the goal's current period. Any goal may be collected (C3). */
  async collect(goalId: bigint): Promise<WriteResult<null>> {
    writerOf(this.loktin.config);
    const goal_id = checkU64(goalId, 'goalId');
    return this.loktin.write('target-savings', 'collect', { goal_id });
  }

  /**
   * Approves a new allowance for the remaining scheduled deposits of all
   * the owner's open goals, `goalId` among them: each worked out with
   * {@link scheduledAllowance}, then combined with
   * {@link combineAllowances}. An approval replaces the owner's whole
   * Target Savings allowance, which covers all their goals (W57, W116).
   * Reads the goals from the chain, never from the adapter.
   */
  async renewAllowance(goalId: bigint): Promise<RenewedAllowance> {
    const owner = writerOf(this.loktin.config);
    const id = checkU64(goalId, 'goalId');
    const [goal, open, { latestLedger, maxEntryTtl }] = await Promise.all([
      this.chain.goal(id),
      this.chain.userGoals(owner),
      this.loktin.ledgerInfo(),
    ]);
    if (goal.owner !== owner) {
      throw new InvalidInputError(
        `goal ${String(id)} is not owned by publicKey`,
      );
    }
    const ledger = { now: new Date(), ledger: latestLedger, maxEntryTtl };
    const goals = open.some((other) => other.id === id)
      ? open
      : [...open, goal];
    const allowance = combineAllowances(
      goals.map((each) => allowanceOf(each, ledger)),
    );
    const approved = await this.loktin.write<null>('token', 'approve', {
      from: owner,
      spender: this.contractId,
      amount: allowance.amount,
      expiration_ledger: allowance.expiryLedger,
    });
    return { ...approved, allowance };
  }

  /**
   * Reads the goal and the token allowance of `publicKey` for Target Savings,
   * in parallel, and says whether the next collection would be short on
   * allowance. The allowance is shared by all the owner's goals, so other
   * goals' collections use it up too. It does not check the owner's
   * balance.
   */
  async allowanceStatus(goalId: bigint): Promise<AllowanceStatus> {
    const owner = userOf(this.loktin.config);
    const id = checkU64(goalId, 'goalId');
    const [goal, allowance] = await Promise.all([
      this.goal(id),
      this.loktin.read<bigint>('token', 'allowance', {
        from: owner,
        spender: this.contractId,
      }),
    ]);
    if (goal.owner !== owner) {
      throw new InvalidInputError(
        `goal ${String(id)} is not owned by publicKey`,
      );
    }
    const needed = goal.target - goal.principal;
    // `collect` refuses after the deadline and once the target is reached.
    const nextAmount =
      needed <= 0n || Date.now() > goal.deadline.getTime()
        ? 0n
        : goal.depositSize < needed
          ? goal.depositSize
          : needed;
    return { allowance, nextAmount, short: allowance < nextAmount };
  }

  /** Returns an open goal. */
  async goal(goalId: bigint): Promise<Goal> {
    const id = checkU64(goalId, 'goalId');
    const adapter = this.adapter;
    return adapter?.goal ? adapter.goal(id) : this.chain.goal(id);
  }

  /**
   * Returns the open goals of `owner`, at most 20. `owner` defaults to
   * `publicKey`. To find every goal, read the `goal_created` and
   * `goal_closed` events instead.
   */
  async userGoals(owner?: string): Promise<readonly Goal[]> {
    const address =
      owner === undefined
        ? userOf(this.loktin.config)
        : checkAddress(owner, 'owner');
    const adapter = this.adapter;
    return adapter?.userGoals
      ? adapter.userGoals(address)
      : this.chain.userGoals(address);
  }

  /** Returns how a withdrawal of the goal would split right now. */
  async previewWithdraw(goalId: bigint): Promise<GoalWithdrawal> {
    const id = checkU64(goalId, 'goalId');
    const adapter = this.adapter;
    return adapter?.previewWithdraw
      ? adapter.previewWithdraw(id)
      : this.chain.previewWithdraw(id);
  }

  /** Returns the token Target Savings holds. */
  async token(): Promise<string> {
    const adapter = this.adapter;
    return adapter?.token ? adapter.token() : this.chain.token();
  }

  /** Returns the Loktin fee rate new goals receive. */
  async loktinFeeBps(): Promise<number> {
    const adapter = this.adapter;
    return adapter?.loktinFeeBps
      ? adapter.loktinFeeBps()
      : this.chain.loktinFeeBps();
  }

  /** Returns the address Loktin fees are paid to. */
  async feeRecipient(): Promise<string> {
    const adapter = this.adapter;
    return adapter?.feeRecipient
      ? adapter.feeRecipient()
      : this.chain.feeRecipient();
  }

  /** Returns the shortest cadence a goal may use, in seconds. */
  async minCadence(): Promise<number> {
    const adapter = this.adapter;
    return adapter?.minCadence ? adapter.minCadence() : this.chain.minCadence();
  }

  /**
   * Pays out every fee accrued to `publicKey` and returns the amount
   * (W63). The call acts for `publicKey`, so it needs only the configured
   * signer. An integrator claims by creating the SDK with its own
   * `publicKey` and signer, and Loktin's fee recipient claims the same way.
   * With nothing accrued, the contract refuses it with `NothingToClaim`.
   * Never uses the read adapter.
   */
  async claimFees(): Promise<WriteResult<bigint>> {
    const recipient = writerOf(this.loktin.config);
    return this.loktin.write<bigint>('target-savings', 'claim_fees', {
      recipient,
    });
  }

  /**
   * Returns the fees accrued to `recipient` and not yet claimed (W63).
   * `recipient` defaults to the module's integrator.
   */
  async accruedFees(recipient?: string): Promise<bigint> {
    const address =
      recipient === undefined
        ? this.integrator
        : checkAddress(recipient, 'recipient');
    const adapter = this.adapter;
    return adapter?.accruedFees
      ? adapter.accruedFees(address)
      : this.chain.accruedFees(address);
  }

  /** Returns whether Target Savings is paused. */
  async paused(): Promise<boolean> {
    const adapter = this.adapter;
    return adapter?.paused ? adapter.paused() : this.chain.paused();
  }
}

/** The scheduled allowance a stored goal still needs, at `ledger`. */
function allowanceOf(
  goal: Goal,
  ledger: { now: Date; ledger: number; maxEntryTtl: number },
): ScheduledAllowance {
  return scheduledAllowance({
    ...ledger,
    start: goal.start,
    deadline: goal.deadline,
    cadenceSeconds: goal.cadenceSeconds,
    depositSize: goal.depositSize,
    target: goal.target,
    principal: goal.principal,
    lastCollectedPeriod: goal.lastCollectedPeriod,
  });
}

// The built-in adapter: each read is one call through the core.
function chainReads(loktin: Loktin): Required<TargetSavingsReadAdapter> {
  const read = <T>(method: string, args?: Record<string, unknown>) =>
    loktin.read<T>('target-savings', method, args);
  return {
    goal: async (id) => toGoal(await read<RawGoal>('goal', { id })),
    userGoals: async (owner) =>
      (await read<RawGoal[]>('user_goals', { owner })).map(toGoal),
    previewWithdraw: async (goal_id) =>
      toGoalWithdrawal(
        await read<RawWithdrawal>('preview_withdraw', { goal_id }),
      ),
    token: () => read<string>('token'),
    loktinFeeBps: () => read<number>('loktin_fee_bps'),
    feeRecipient: () => read<string>('fee_recipient'),
    minCadence: async () => Number(await read<bigint>('min_cadence')),
    paused: () => read<boolean>('paused'),
    accruedFees: (recipient) => read<bigint>('accrued_fees', { recipient }),
  };
}
