// Pure helpers of the testnet smoke script (V6): the phases' budgets, the
// latency summary, matching an evidence goal and the evidence records. No
// Node.js API and no network call here, so the unit tests can cover them.
import type { Goal, WithdrawalRule } from '@loktin/sdk/target-savings';

export const PHASES = ['goals', 'run', 'window'] as const;
export type Phase = (typeof PHASES)[number];

export function isPhase(value: unknown): value is Phase {
  return (PHASES as readonly unknown[]).includes(value);
}

/** The four roles of the smoke run, each one of the owner's aliases (W84). */
export const ROLES = ['userA', 'userB', 'integratorA', 'integratorB'] as const;
export type Role = (typeof ROLES)[number];
export type User = 'userA' | 'userB';

/** USDC has 7 decimals: one USDC in base units. */
export const USDC = 10_000_000n;
export const DAY = 86_400;

/** The W70 targets the latency sample is set against. */
export const TARGETS = { readP95Ms: 1_000, writeP95Ms: 15_000 } as const;

/** What an evidence goal looks like, to find it again on a rerun (W87). */
export interface EvidenceGoalSpec {
  readonly integrator: string;
  readonly target: bigint;
  readonly depositSize: bigint;
  readonly cadenceSeconds: number;
  readonly rule: WithdrawalRule;
}

/** The first goal that matches the spec, or undefined. */
export function findEvidenceGoal(
  goals: readonly Goal[],
  spec: EvidenceGoalSpec,
): Goal | undefined {
  return goals.find(
    (goal) =>
      goal.integrator === spec.integrator &&
      goal.target === spec.target &&
      goal.depositSize === spec.depositSize &&
      goal.cadenceSeconds === spec.cadenceSeconds &&
      sameRule(goal.rule, spec.rule),
  );
}

function sameRule(a: WithdrawalRule, b: WithdrawalRule): boolean {
  return a.kind === 'penalty'
    ? b.kind === 'penalty' && a.bps === b.bps
    : b.kind === 'lock';
}

/** The skim on a spend, as Spend & Save works it out (P12). */
export function skimOf(
  spent: bigint,
  percentBps: number,
  roundUpUnit?: bigint,
): bigint {
  const percentPart = (spent * BigInt(percentBps)) / 10_000n;
  const roundUpPart =
    roundUpUnit === undefined
      ? 0n
      : (roundUpUnit - (spent % roundUpUnit)) % roundUpUnit;
  const skim = percentPart + roundUpPart;
  return skim < spent ? skim : spent;
}

/** Each user's 5 USDC reserve for the keeper's evidence goal collections. */
export const EVIDENCE_RESERVE = 5n * USDC;

/**
 * The USDC each user needs before a phase starts: everything the phase pays
 * out of the user's wallet, counted without the money it later gets back,
 * plus the evidence-goal reserve in `goals` and `run`.
 */
export function phaseBudget(phase: Phase): Readonly<Record<User, bigint>> {
  switch (phase) {
    case 'goals':
      return { userA: EVIDENCE_RESERVE, userB: EVIDENCE_RESERVE };
    case 'run': {
      // Per user: the penalty goal deposit, both lock goal deposits and the
      // 25 spare-goal deposits of 0.01.
      const goals = 1n * USDC + 1n * USDC + 25n * (USDC / 100n);
      // User A only: the payment, its skim to integrator A's balance, then
      // the two saves for a spend and their skims.
      const spendSave =
        (125n * USDC) / 100n +
        skimOf((125n * USDC) / 100n, 500, USDC) +
        skimOf(2n * USDC, 500, USDC) +
        skimOf(2n * USDC, 1_000);
      return {
        userA: goals + spendSave + EVIDENCE_RESERVE,
        userB: goals + EVIDENCE_RESERVE,
      };
    }
    case 'window':
      return { userA: 0n, userB: 0n };
  }
}

/** One alias's funding, read before any write. */
export interface Funding {
  readonly role: Role;
  readonly alias: string;
  /** XLM balance in stroops, or undefined when the account is missing. */
  readonly xlm: bigint | undefined;
  /** USDC balance in base units, or undefined without a trustline. */
  readonly usdc: bigint | undefined;
}

/** Each alias needs at least 10 XLM for fees. */
export const MIN_XLM_STROOPS = 10n * 10_000_000n;

/** Everything that is short, one line per problem. Empty when all is well. */
export function preflightProblems(
  funding: readonly Funding[],
  budget: Readonly<Record<User, bigint>>,
): string[] {
  const problems: string[] = [];
  for (const { role, alias, xlm, usdc } of funding) {
    if (xlm === undefined) {
      problems.push(`${alias} (${role}): no account on this network`);
    } else if (xlm < MIN_XLM_STROOPS) {
      problems.push(
        `${alias} (${role}): ${formatUnits(xlm)} XLM, needs at least 10 XLM`,
      );
    }
    if (usdc === undefined) {
      problems.push(`${alias} (${role}): no USDC trustline`);
    } else if (role === 'userA' || role === 'userB') {
      const needed = budget[role];
      if (usdc < needed) {
        problems.push(
          `${alias} (${role}): ${formatUnits(usdc)} USDC, needs ${formatUnits(needed)} USDC`,
        );
      }
    }
  }
  return problems;
}

/** A 7-decimal amount as a decimal string, such as `4.6125`. */
export function formatUnits(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / 10_000_000n;
  const fraction = (abs % 10_000_000n)
    .toString()
    .padStart(7, '0')
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${fraction === '' ? '' : `.${fraction}`}`;
}

/** The p-th percentile, nearest rank, of a list of times. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? Number.NaN;
}

export interface LatencySummary {
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export function summarise(values: readonly number[]): LatencySummary {
  return {
    count: values.length,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    maxMs: values.length === 0 ? Number.NaN : Math.max(...values),
  };
}

export function explorerLink(hash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${hash}`;
}

/** One confirmed write, as the evidence file records it (W89). */
export interface StepRecord {
  readonly label: string;
  /** Such as `targetSavings.createGoal`. */
  readonly call: string;
  readonly actor: string;
  readonly hash: string;
  readonly ledger: number;
  /** The fee charged, in stroops, as a decimal string. */
  readonly feeCharged: string;
  /** From the call to the confirmed result, without signing. */
  readonly timeMs: number;
  readonly signingMs: number;
  readonly explorer: string;
}

export function stepRecord(input: {
  label: string;
  call: string;
  actor: string;
  hash: string;
  ledger: number;
  feeCharged: bigint;
  totalMs: number;
  signingMs: number;
}): StepRecord {
  return {
    label: input.label,
    call: input.call,
    actor: input.actor,
    hash: input.hash,
    ledger: input.ledger,
    feeCharged: input.feeCharged.toString(),
    timeMs: Math.max(0, Math.round(input.totalMs - input.signingMs)),
    signingMs: Math.round(input.signingMs),
    explorer: explorerLink(input.hash),
  };
}

/** A refusal the run expects, recorded by its error (no transaction). */
export interface RefusalRecord {
  readonly label: string;
  readonly code: string;
  readonly errorName: string;
}

/** A check made by reading, such as the final evidence-goal check. */
export interface CheckRecord {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

/** The evidence file of one phase. */
export interface Evidence {
  phase: Phase;
  network: {
    passphrase: string;
    rpcUrl: string;
    targetSavings: string;
    spendSave: string;
    token: string;
  };
  sdkVersion: string;
  commit: string;
  startedAt: string;
  endedAt: string | null;
  complete: boolean;
  aliases: { role: Role; alias: string; address: string }[];
  steps: StepRecord[];
  refusals: RefusalRecord[];
  checks: CheckRecord[];
  skipped: { label: string; reason: string }[];
  goals?: {
    user: User;
    id: string;
    created: boolean;
    hash: string | null;
    allowance: string | null;
    expiryLedger: number | null;
    renewBy: string | null;
  }[];
  latency?: {
    reads: LatencySummary;
    writes: LatencySummary;
    targets: typeof TARGETS;
    readsMeetTarget: boolean;
    writesMeetTarget: boolean;
  };
  error?: { code: string; name: string; message: string; hash?: string };
}

/** JSON with bigints as decimal strings. */
export function toJson(value: unknown): string {
  return `${JSON.stringify(
    value,
    (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  )}\n`;
}

/** What a rerun of `run` does with a goal an earlier stopped run left open. */
export type TidyAction =
  | {
      readonly kind: 'withdraw';
      readonly goalId: bigint;
      readonly reason: string;
    }
  | {
      readonly kind: 'fill-then-withdraw';
      readonly goalId: bigint;
      /** The deposit that brings the lock goal to its target. */
      readonly amount: bigint;
    };

/**
 * The tidy-up for one user before `run` (W92): the evidence goal is left
 * alone, and every other open goal is closed. An empty goal, one at its
 * target, or one at or past its deadline is withdrawn with no penalty; a
 * penalty goal is withdrawn early; a lock goal is first filled to its
 * target. `evidence` is undefined when the user's evidence goal is missing.
 */
export function tidyUpPlan(
  goals: readonly Goal[],
  spec: EvidenceGoalSpec,
  now: Date,
): { evidence: Goal | undefined; actions: TidyAction[] } {
  const evidence = findEvidenceGoal(goals, spec);
  const actions: TidyAction[] = [];
  for (const goal of goals) {
    if (goal.id === evidence?.id) {
      continue;
    }
    if (goal.principal === 0n) {
      actions.push({ kind: 'withdraw', goalId: goal.id, reason: 'empty' });
    } else if (goal.principal >= goal.target) {
      actions.push({
        kind: 'withdraw',
        goalId: goal.id,
        reason: 'at its target',
      });
    } else if (now.getTime() >= goal.deadline.getTime()) {
      actions.push({
        kind: 'withdraw',
        goalId: goal.id,
        reason: 'at or past its deadline',
      });
    } else if (goal.rule.kind === 'penalty') {
      actions.push({
        kind: 'withdraw',
        goalId: goal.id,
        reason: 'early, with its penalty',
      });
    } else {
      actions.push({
        kind: 'fill-then-withdraw',
        goalId: goal.id,
        amount: goal.target - goal.principal,
      });
    }
  }
  return { evidence, actions };
}
