import {
  MAX_INTEGRATOR_FEE_BPS,
  MAX_LOKTIN_FEE_BPS,
  checkBps,
  checkPositive,
} from '../validate.js';
import { type WithdrawalRule, checkRule } from './types.js';

/** The inputs of {@link creationBreakdown}. */
export interface CreationBreakdownInput {
  readonly target: bigint;
  readonly rule: WithdrawalRule;
  /** The Loktin fee rate new goals receive, from `TargetSavings.loktinFeeBps()`. */
  readonly loktinFeeBps: number;
  readonly integratorFeeBps: number;
}

/** The worst case for an early withdrawal of the whole target. */
export interface CreationBreakdown {
  /** The whole target. */
  readonly amount: bigint;
  /** The early-withdrawal penalty, 0 for a lock rule. */
  readonly penalty: bigint;
  readonly loktinFee: bigint;
  readonly integratorFee: bigint;
  /** What the owner receives. */
  readonly toUser: bigint;
  /**
   * True for a lock rule: there is no early withdrawal, and the goal can be
   * withdrawn only once the target is reached or the deadline passes. The
   * fees still apply then.
   */
  readonly locked: boolean;
}

// floor(amount × bps / 10,000), as common/src/fees.rs rounds it.
function bpsOf(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / 10_000n;
}

/**
 * Works out how an early withdrawal of the whole target would split, so the
 * app can show it before the user signs (R2, R4). Each part is taken from the
 * principal and rounded down, as the contract does. No network call.
 */
export function creationBreakdown(
  input: CreationBreakdownInput,
): CreationBreakdown {
  const target = checkPositive(input.target, 'target', 'InvalidTarget');
  const loktinFeeBps = checkBps(
    input.loktinFeeBps,
    'loktinFeeBps',
    MAX_LOKTIN_FEE_BPS,
  );
  const integratorFeeBps = checkBps(
    input.integratorFeeBps,
    'integratorFeeBps',
    MAX_INTEGRATOR_FEE_BPS,
  );
  const rule = checkRule(input.rule);
  const penaltyBps = rule.kind === 'penalty' ? rule.bps : 0;
  const penalty = bpsOf(target, penaltyBps);
  const loktinFee = bpsOf(target, loktinFeeBps);
  const integratorFee = bpsOf(target, integratorFeeBps);
  return {
    amount: target,
    penalty,
    loktinFee,
    integratorFee,
    toUser: target - penalty - loktinFee - integratorFee,
    locked: rule.kind === 'lock',
  };
}
