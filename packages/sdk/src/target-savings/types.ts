import { InvalidInputError } from '../errors.js';
import { MAX_PENALTY_BPS, checkBps, dateOf } from '../validate.js';

/** What happens when the owner withdraws before the target or deadline (P4). */
export type WithdrawalRule =
  | {
      readonly kind: 'penalty';
      /** The penalty in basis points, at most 1,000, paid to the integrator. */
      readonly bps: number;
    }
  | {
      /** No withdrawal until the target is reached or the deadline passes. */
      readonly kind: 'lock';
    };

/** An open savings goal. */
export interface Goal {
  readonly id: bigint;
  readonly owner: string;
  readonly integrator: string;
  readonly integratorFeeBps: number;
  readonly loktinFeeBps: number;
  readonly target: bigint;
  readonly deadline: Date;
  readonly cadenceSeconds: number;
  readonly depositSize: bigint;
  readonly rule: WithdrawalRule;
  /** The ledger time at creation. Period k is due at `start + k × cadence`. */
  readonly start: Date;
  readonly principal: bigint;
  readonly shares: bigint;
  /** The last period collected, or 0 when none has been. */
  readonly lastCollectedPeriod: bigint;
  readonly missedCount: bigint;
}

/** How a withdrawal of a goal splits between its recipients. */
export interface GoalWithdrawal {
  /** The whole principal withdrawn. */
  readonly amount: bigint;
  /** The early-withdrawal penalty, paid to the integrator. */
  readonly penalty: bigint;
  readonly loktinFee: bigint;
  readonly integratorFee: bigint;
  /** What the owner receives. */
  readonly toUser: bigint;
}

/**
 * Target Savings reads served from somewhere other than the chain (K9). Each
 * method is optional; a read without one goes to the chain.
 */
export interface TargetSavingsReadAdapter {
  goal?(goalId: bigint): Promise<Goal>;
  userGoals?(owner: string): Promise<readonly Goal[]>;
  openGoals?(fromId: bigint, limit: number): Promise<readonly Goal[]>;
  nextId?(): Promise<bigint>;
  previewWithdraw?(goalId: bigint): Promise<GoalWithdrawal>;
  token?(): Promise<string>;
  loktinFeeBps?(): Promise<number>;
  feeRecipient?(): Promise<string>;
  minCadence?(): Promise<number>;
  paused?(): Promise<boolean>;
}

// The shapes the contract spec decodes to.
export type RawRule = { tag: 'Penalty'; values: [number] } | { tag: 'Lock' };

export interface RawGoal {
  id: bigint;
  owner: string;
  integrator: string;
  integrator_fee_bps: number;
  loktin_fee_bps: number;
  target: bigint;
  deadline: bigint;
  cadence: bigint;
  deposit_size: bigint;
  rule: RawRule;
  start: bigint;
  principal: bigint;
  shares: bigint;
  last_collected_period: bigint;
  missed_count: bigint;
}

export interface RawWithdrawal {
  amount: bigint;
  penalty: bigint;
  loktin_fee: bigint;
  integrator_fee: bigint;
  to_user: bigint;
}

export function toGoal(raw: RawGoal): Goal {
  return {
    id: raw.id,
    owner: raw.owner,
    integrator: raw.integrator,
    integratorFeeBps: raw.integrator_fee_bps,
    loktinFeeBps: raw.loktin_fee_bps,
    target: raw.target,
    deadline: dateOf(raw.deadline),
    cadenceSeconds: Number(raw.cadence),
    depositSize: raw.deposit_size,
    rule:
      raw.rule.tag === 'Penalty'
        ? { kind: 'penalty', bps: raw.rule.values[0] }
        : { kind: 'lock' },
    start: dateOf(raw.start),
    principal: raw.principal,
    shares: raw.shares,
    lastCollectedPeriod: raw.last_collected_period,
    missedCount: raw.missed_count,
  };
}

export function toGoalWithdrawal(raw: RawWithdrawal): GoalWithdrawal {
  return {
    amount: raw.amount,
    penalty: raw.penalty,
    loktinFee: raw.loktin_fee,
    integratorFee: raw.integrator_fee,
    toUser: raw.to_user,
  };
}

export function toRawRule(rule: WithdrawalRule): RawRule {
  return rule.kind === 'penalty'
    ? { tag: 'Penalty', values: [rule.bps] }
    : { tag: 'Lock' };
}

/** Checks a withdrawal rule; a penalty above 1,000 is refused as RateAboveCap. */
export function checkRule(rule: unknown): WithdrawalRule {
  if (typeof rule === 'object' && rule !== null && 'kind' in rule) {
    if (rule.kind === 'lock') {
      return { kind: 'lock' };
    }
    if (rule.kind === 'penalty') {
      const bps = 'bps' in rule ? rule.bps : undefined;
      return {
        kind: 'penalty',
        bps: checkBps(bps, 'rule.bps', MAX_PENALTY_BPS),
      };
    }
  }
  throw new InvalidInputError(
    "rule must be { kind: 'penalty', bps } or { kind: 'lock' }",
  );
}
