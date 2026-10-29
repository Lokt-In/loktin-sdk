import { InvalidInputError } from '../errors.js';
import {
  checkBigInt,
  checkDate,
  checkU32,
  checkU64,
  secondsOf,
} from '../validate.js';

/** The ledger close time the SDK assumes, measured on testnet (W57). */
export const SECONDS_PER_LEDGER = 5;
/** Margin added after the deadline's ledger: one day of ledgers. */
export const EXPIRY_MARGIN_LEDGERS = 17_280;
/** How long before the expiry a renewal is asked for. */
const RENEW_BEFORE_SECONDS = 7 * 86_400;

/** The inputs of {@link scheduledAllowance}. */
export interface ScheduledAllowanceInput {
  /** The current time. */
  readonly now: Date;
  /** The latest ledger, from `Loktin.ledgerInfo()`. */
  readonly ledger: number;
  /** The longest entry time to live, from `Loktin.ledgerInfo()`. */
  readonly maxEntryTtl: number;
  /** The goal's start. For a new goal, `now`. */
  readonly start: Date;
  readonly deadline: Date;
  readonly cadenceSeconds: number;
  readonly depositSize: bigint;
  readonly target: bigint;
  readonly principal: bigint;
  /** The last period collected. For a new goal, 0. */
  readonly lastCollectedPeriod: bigint;
}

/** An allowance for the scheduled deposits of a goal. */
export interface ScheduledAllowance {
  /** The amount to approve, in base units. */
  readonly amount: bigint;
  /** The ledger the approval lasts until. */
  readonly expiryLedger: number;
  /** When `expiryLedger` is expected, at 5 seconds per ledger. */
  readonly expiresAt: Date;
  /** How many scheduled deposits the amount covers, before the cap at what the goal still needs. */
  readonly periods: bigint;
  /**
   * Set when the network caps the expiry before the deadline: renew the
   * allowance by this time, 7 days before the expected expiry.
   */
  readonly renewBy?: Date;
}

/**
 * Works out the allowance that covers a goal's scheduled deposits until the
 * allowance expires (W57). No network call.
 *
 * The expiry is the deadline's ledger, estimated at 5 seconds per ledger,
 * plus one day of ledgers, capped at the latest ledger the network allows.
 * The amount covers each period from the first one still collectable up to
 * the earlier of the deadline and the expiry, capped at what the goal still
 * needs. Missed periods are never collected, so they are not counted. After
 * the deadline second nothing is left to collect, so the amount is 0; the
 * deadline second itself is still inside the goal.
 */
export function scheduledAllowance(
  input: ScheduledAllowanceInput,
): ScheduledAllowance {
  const now = secondsOf(checkDate(input.now, 'now'));
  const start = secondsOf(checkDate(input.start, 'start'));
  const deadline = secondsOf(checkDate(input.deadline, 'deadline'));
  const ledger = checkU32(input.ledger, 'ledger');
  const maxEntryTtl = checkU32(input.maxEntryTtl, 'maxEntryTtl');
  const cadence = input.cadenceSeconds;
  if (!Number.isSafeInteger(cadence) || cadence <= 0) {
    throw new InvalidInputError(
      'cadenceSeconds must be a whole number of seconds above zero',
    );
  }
  const depositSize = checkBigInt(input.depositSize, 'depositSize');
  const target = checkBigInt(input.target, 'target');
  const principal = checkBigInt(input.principal, 'principal');
  const lastCollected = checkU64(
    input.lastCollectedPeriod,
    'lastCollectedPeriod',
  );
  if (maxEntryTtl === 0) {
    throw new InvalidInputError('maxEntryTtl must be above zero');
  }

  const deadlineLedger =
    ledger + Math.ceil((deadline - now) / SECONDS_PER_LEDGER);
  const capLedger = ledger + maxEntryTtl - 1;
  const wanted = deadlineLedger + EXPIRY_MARGIN_LEDGERS;
  const expiryLedger = Math.min(wanted, capLedger);
  const expiresAt = now + (expiryLedger - ledger) * SECONDS_PER_LEDGER;

  const until = Math.min(deadline, expiresAt);
  const lastPeriod = BigInt(Math.floor((until - start) / cadence));
  const currentPeriod = BigInt(
    Math.max(Math.floor((now - start) / cadence), 1),
  );
  const firstPeriod =
    lastCollected + 1n > currentPeriod ? lastCollected + 1n : currentPeriod;
  // `collect` refuses any call after the deadline second (DeadlinePassed).
  const periods =
    now <= deadline && lastPeriod >= firstPeriod
      ? lastPeriod - firstPeriod + 1n
      : 0n;

  const needed = target > principal ? target - principal : 0n;
  const scheduled = depositSize * periods;
  const allowance: ScheduledAllowance = {
    amount: scheduled < needed ? scheduled : needed,
    expiryLedger,
    expiresAt: new Date(expiresAt * 1000),
    periods,
  };
  if (wanted > capLedger && expiresAt < deadline) {
    return {
      ...allowance,
      renewBy: new Date((expiresAt - RENEW_BEFORE_SECONDS) * 1000),
    };
  }
  return allowance;
}

/**
 * Combines the allowances of several goals into one (W116). An owner has a
 * single token allowance for Target Savings, and each approval replaces it,
 * so one approval must cover all of the owner's goals. The amounts and
 * periods are summed, the expiry is the latest one (with its expected
 * time), and `renewBy` is the earliest one present. No network call.
 */
export function combineAllowances(
  allowances: readonly ScheduledAllowance[],
): ScheduledAllowance {
  const [first, ...rest] = allowances;
  if (first === undefined) {
    throw new InvalidInputError(
      'combineAllowances needs at least one allowance',
    );
  }
  let amount = first.amount;
  let periods = first.periods;
  let latest = first;
  let renewBy = first.renewBy;
  for (const allowance of rest) {
    amount += allowance.amount;
    periods += allowance.periods;
    if (allowance.expiryLedger > latest.expiryLedger) {
      latest = allowance;
    }
    if (
      allowance.renewBy !== undefined &&
      (renewBy === undefined || allowance.renewBy < renewBy)
    ) {
      renewBy = allowance.renewBy;
    }
  }
  const combined: ScheduledAllowance = {
    amount,
    expiryLedger: latest.expiryLedger,
    expiresAt: latest.expiresAt,
    periods,
  };
  return renewBy === undefined ? combined : { ...combined, renewBy };
}
