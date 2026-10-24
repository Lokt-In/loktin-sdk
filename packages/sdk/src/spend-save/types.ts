import type { TimeWindow } from '../time.js';
import { dateOf } from '../validate.js';

/** How a skim is worked out from a spend (P12). At least one part is set. */
export interface SkimSettings {
  /** A percentage of the spend, in basis points, 100 to 5,000. */
  readonly percentBps?: number | undefined;
  /** Round the spend up to a multiple of this unit, in base units, above zero. */
  readonly roundUpUnit?: bigint | undefined;
}

/** Where skims go (P15). */
export type Destination =
  | { readonly kind: 'balance' }
  | { readonly kind: 'goal'; readonly goalId: bigint };

/** A change of withdrawal day waiting for its month (P16). */
export interface PendingDay {
  readonly day: number;
  /** The month index, `year × 12 + (month − 1)` in UTC, it takes effect from. */
  readonly fromMonth: number;
}

/** A user's enrolment with one integrator, as stored. */
export interface Enrollment {
  readonly user: string;
  readonly integrator: string;
  readonly integratorFeeBps: number;
  readonly loktinFeeBps: number;
  readonly skim: {
    readonly percentBps: number | undefined;
    readonly roundUpUnit: bigint | undefined;
  };
  readonly monthlyCap: bigint | undefined;
  readonly destination: Destination;
  /** The stored withdrawal day. A pending change may already apply: see `effectiveWithdrawalDay`. */
  readonly withdrawalDay: number;
  readonly pendingDay: PendingDay | undefined;
  /** The Spend & Save balance. */
  readonly principal: bigint;
  readonly shares: bigint;
  /** The month `savedThisMonth` belongs to. */
  readonly monthIndex: number;
  readonly savedThisMonth: bigint;
  readonly totalSpent: bigint;
  readonly totalSaved: bigint;
}

/** How a spend would be skimmed, before the wallet is checked (P12, P13). */
export interface SkimPreview {
  readonly spent: bigint;
  readonly percentPart: bigint;
  readonly roundUpPart: bigint;
  /** The two parts added together, never more than `spent`. */
  readonly skim: bigint;
  /** How much the monthly cap trims off the skim. */
  readonly capTrimmed: bigint;
  /** The skim after the cap. */
  readonly capped: bigint;
}

/** What one skim saved, and where it went (P14, S10). */
export interface Saving {
  /** The skim before trimming. */
  readonly skim: bigint;
  readonly capTrimmed: bigint;
  /** How much the wallet could not cover. */
  readonly shortfall: bigint;
  readonly toBalance: bigint;
  readonly toGoal: bigint;
  /** The goal that received `toGoal`, when it is above zero. */
  readonly goalId: bigint | undefined;
}

/** How a Spend & Save withdrawal splits. Spend & Save has no penalty. */
export interface SpendSaveWithdrawal {
  readonly amount: bigint;
  readonly loktinFee: bigint;
  readonly integratorFee: bigint;
  readonly toUser: bigint;
}

/**
 * Spend & Save reads served from somewhere other than the chain (K9). Each
 * method is optional; a read without one goes to the chain.
 */
export interface SpendSaveReadAdapter {
  enrollment?(user: string, integrator: string): Promise<Enrollment>;
  previewSkim?(
    user: string,
    integrator: string,
    spent: bigint,
  ): Promise<SkimPreview>;
  previewWithdraw?(
    user: string,
    integrator: string,
    amount: bigint,
  ): Promise<SpendSaveWithdrawal>;
  nextWindow?(user: string, integrator: string): Promise<TimeWindow>;
  targetSavings?(): Promise<string | undefined>;
  token?(): Promise<string>;
  loktinFeeBps?(): Promise<number>;
  feeRecipient?(): Promise<string>;
  paused?(): Promise<boolean>;
}

// The shapes the contract spec decodes to. An empty option decodes to null.
export interface RawSkim {
  percent_bps: number | null;
  round_up_unit: bigint | null;
}

export type RawDestination =
  { tag: 'Balance' } | { tag: 'Goal'; values: [bigint] };

export interface RawEnrollment {
  user: string;
  integrator: string;
  integrator_fee_bps: number;
  loktin_fee_bps: number;
  skim: RawSkim;
  monthly_cap: bigint | null;
  destination: RawDestination;
  withdrawal_day: number;
  pending_day: { tag: 'None' } | { tag: 'Pending'; values: [number, number] };
  principal: bigint;
  shares: bigint;
  month_index: number;
  saved_this_month: bigint;
  total_spent: bigint;
  total_saved: bigint;
}

export interface RawSkimPreview {
  spent: bigint;
  percent_part: bigint;
  round_up_part: bigint;
  skim: bigint;
  cap_trimmed: bigint;
  capped: bigint;
}

export interface RawSaving {
  skim: bigint;
  cap_trimmed: bigint;
  shortfall: bigint;
  to_balance: bigint;
  to_goal: bigint;
  goal_id: bigint | null;
}

export interface RawWithdrawal {
  amount: bigint;
  loktin_fee: bigint;
  integrator_fee: bigint;
  to_user: bigint;
}

export function toEnrollment(raw: RawEnrollment): Enrollment {
  return {
    user: raw.user,
    integrator: raw.integrator,
    integratorFeeBps: raw.integrator_fee_bps,
    loktinFeeBps: raw.loktin_fee_bps,
    skim: {
      percentBps: raw.skim.percent_bps ?? undefined,
      roundUpUnit: raw.skim.round_up_unit ?? undefined,
    },
    monthlyCap: raw.monthly_cap ?? undefined,
    destination:
      raw.destination.tag === 'Goal'
        ? { kind: 'goal', goalId: raw.destination.values[0] }
        : { kind: 'balance' },
    withdrawalDay: raw.withdrawal_day,
    pendingDay:
      raw.pending_day.tag === 'Pending'
        ? {
            day: raw.pending_day.values[0],
            fromMonth: raw.pending_day.values[1],
          }
        : undefined,
    principal: raw.principal,
    shares: raw.shares,
    monthIndex: raw.month_index,
    savedThisMonth: raw.saved_this_month,
    totalSpent: raw.total_spent,
    totalSaved: raw.total_saved,
  };
}

export function toSkimPreview(raw: RawSkimPreview): SkimPreview {
  return {
    spent: raw.spent,
    percentPart: raw.percent_part,
    roundUpPart: raw.round_up_part,
    skim: raw.skim,
    capTrimmed: raw.cap_trimmed,
    capped: raw.capped,
  };
}

export function toSaving(raw: RawSaving): Saving {
  return {
    skim: raw.skim,
    capTrimmed: raw.cap_trimmed,
    shortfall: raw.shortfall,
    toBalance: raw.to_balance,
    toGoal: raw.to_goal,
    goalId: raw.goal_id ?? undefined,
  };
}

export function toWithdrawal(raw: RawWithdrawal): SpendSaveWithdrawal {
  return {
    amount: raw.amount,
    loktinFee: raw.loktin_fee,
    integratorFee: raw.integrator_fee,
    toUser: raw.to_user,
  };
}

export function toWindow([start, end]: [bigint, bigint]): TimeWindow {
  return { start: dateOf(start), end: dateOf(end) };
}

export function toRawDestination(destination: Destination): RawDestination {
  return destination.kind === 'goal'
    ? { tag: 'Goal', values: [destination.goalId] }
    : { tag: 'Balance' };
}

/** `year × 12 + (month − 1)` of a time, in UTC, as common/src/calendar.rs counts months. */
export function monthIndex(date: Date): number {
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

/**
 * The withdrawal day that applies at `now`, by the contract's rule: a pending
 * change applies once the month index reaches its `fromMonth` (P16). For
 * display only. It uses the device clock in UTC, and at the edge of a month
 * the chain's ledger time decides.
 */
export function effectiveWithdrawalDay(
  enrollment: Pick<Enrollment, 'withdrawalDay' | 'pendingDay'>,
  now: Date = new Date(),
): number {
  const pending = enrollment.pendingDay;
  return pending !== undefined && monthIndex(now) >= pending.fromMonth
    ? pending.day
    : enrollment.withdrawalDay;
}
