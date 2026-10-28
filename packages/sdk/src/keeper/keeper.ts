import {
  StrKey,
  TransactionBuilder,
  scValToNative,
} from '@stellar/stellar-sdk/base';
import type { SignTransaction } from '@stellar/stellar-sdk/contract';
import { type Api, Server } from '@stellar/stellar-sdk/rpc';
import { ScVal } from '@stellar/stellar-sdk/xdr';
import {
  ContractError,
  InvalidInputError,
  NetworkError,
  PendingError,
  SignerRefusedError,
  TransactionFailedError,
} from '../errors.js';
import type { Loktin } from '../loktin.js';
import { type Goal, type RawGoal, toGoal } from '../target-savings/types.js';

/** Which goals a keeper serves (E2). */
export interface ScanOptions {
  /** Integrator addresses whose goals are served, or `'all'`. */
  readonly integrators: readonly string[] | 'all';
  /**
   * Owners whose open goals are added through `userGoals`, filtered by the
   * same integrators. This finds goals whose creation event has left the
   * RPC's retention window.
   */
  readonly owners?: readonly string[];
}

/** What a scan found (E1). */
export interface ScanResult {
  /** The goals served, with their current data. */
  readonly goals: readonly Goal[];
  /** `goal_created` and `goal_closed` events read. */
  readonly events: number;
  /** `getEvents` calls made. */
  readonly pages: number;
  /** The ledgers the event scan covered. */
  readonly fromLedger: number;
  readonly toLedger: number;
}

/**
 * Ledgers added to the RPC's oldest ledger before the event scan starts,
 * about 5 minutes. A full retention window moves one ledger about every 5
 * seconds, so a start at the oldest ledger is often refused by the time it
 * arrives.
 */
export const START_MARGIN_LEDGERS = 60;

/**
 * Where the event scan starts. The oldest ledger only moves once the RPC's
 * retention window is full, so the margin applies then. A younger window
 * does not move, and starting past its oldest ledger would skip events (or
 * pass its latest ledger), so the scan starts at the oldest ledger.
 */
export function scanStart(health: Api.GetHealthResponse): number {
  const full =
    health.latestLedger - health.oldestLedger >=
    health.ledgerRetentionWindow - START_MARGIN_LEDGERS;
  return full
    ? health.oldestLedger + START_MARGIN_LEDGERS
    : health.oldestLedger;
}
/** The SDK's read retries (K6): 3 more tries, on network errors only. */
const RETRY_DELAYS_MS = [500, 1000, 2000];

/** Events per `getEvents` call. */
const PAGE_LIMIT = 1000;
/** A guard against an RPC whose cursor never settles. */
const MAX_PAGES = 10_000;

const CREATED = ScVal.scvSymbol('goal_created').toXdr('base64');
const CLOSED = ScVal.scvSymbol('goal_closed').toXdr('base64');

/** The RPC server a keeper reads events from: the configured one, or one like the SDK builds. */
function serverOf(loktin: Loktin): Server {
  const { server, rpcUrl, allowHttp, requestTimeoutMs } = loktin.config;
  if (server !== undefined) {
    return server;
  }
  const built = new Server(rpcUrl, { allowHttp });
  // As in the core: stellar-sdk honours this default on every request (K6).
  built.httpClient.defaults.timeout = requestTimeoutMs;
  return built;
}

function isAddress(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value))
  );
}

function checkScanOptions(options: ScanOptions): void {
  const integrators: unknown = options.integrators;
  if (
    integrators !== 'all' &&
    (!Array.isArray(integrators) ||
      integrators.length === 0 ||
      !integrators.every(isAddress))
  ) {
    throw new InvalidInputError(
      "integrators must be 'all' or a list of account (G...) or contract (C...) addresses",
    );
  }
  if (options.owners !== undefined && !options.owners.every(isAddress)) {
    throw new InvalidInputError(
      'owners must be account (G...) or contract (C...) addresses',
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls the RPC directly, retrying a network failure as the SDK's reads do.
 * stellar-sdk throws a transport failure (such as "fetch failed" or a
 * timeout) as an Error, and a JSON-RPC error answer as a plain
 * `{ code, message }` object, which is passed on unchanged for the caller.
 */
async function withRetries<T>(
  what: string,
  call: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        throw new NetworkError(`${what} failed: ${error.message}`, {
          cause: error,
        });
      }
      await sleep(delay);
    }
  }
}

/** The message of a JSON-RPC error answer, or undefined for anything else. */
function refusalMessage(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    !(error instanceof Error) &&
    'message' in error &&
    typeof error.message === 'string'
    ? error.message
    : undefined;
}

function isOutOfRange(error: unknown): boolean {
  return (
    refusalMessage(error)?.includes(
      'startLedger must be within the ledger range',
    ) === true
  );
}

/**
 * Finds the goals a keeper serves (E1, W96). It pages the `goal_created`
 * and `goal_closed` events of Target Savings across the RPC's retention
 * window, following the cursor until it stops changing (most pages are
 * empty), keeps created goals whose integrator matches and that have not
 * closed, adds the open goals of the given owners, and reads each goal's
 * current data. Once the RPC's window is full, the scan starts
 * {@link START_MARGIN_LEDGERS} after its oldest ledger ({@link scanStart}),
 * and every RPC call is retried on network errors.
 */
export async function scanGoals(
  loktin: Loktin,
  options: ScanOptions,
): Promise<ScanResult> {
  try {
    return await scan(loktin, options);
  } catch (error) {
    // Any other JSON-RPC refusal, passed on as a NETWORK error.
    const message = refusalMessage(error);
    if (message !== undefined) {
      throw new NetworkError(`the RPC refused the event scan: ${message}`);
    }
    throw error;
  }
}

async function scan(loktin: Loktin, options: ScanOptions): Promise<ScanResult> {
  checkScanOptions(options);
  const server = serverOf(loktin);
  const serves = (integrator: string) =>
    options.integrators === 'all' || options.integrators.includes(integrator);

  const health = () => withRetries('getHealth', () => server.getHealth());
  const filters = [
    {
      type: 'contract' as const,
      contractIds: [loktin.config.contracts.targetSavings],
      topics: [
        [CREATED, '**'],
        [CLOSED, '**'],
      ],
    },
  ];
  const created = new Set<bigint>();
  const closed = new Set<bigint>();
  let events = 0;
  const firstPage = (startLedger: number) =>
    withRetries('getEvents', () =>
      server.getEvents({ startLedger, filters, limit: PAGE_LIMIT }),
    );
  let startLedger = scanStart(await health());
  let pages = 1;
  let page: Api.GetEventsResponse;
  try {
    page = await firstPage(startLedger);
  } catch (error) {
    if (!isOutOfRange(error)) {
      throw error;
    }
    // The window moved past the start: once more from a fresh oldest ledger.
    startLedger = scanStart(await health());
    pages += 1;
    page = await firstPage(startLedger);
  }
  for (;;) {
    for (const event of page.events) {
      const [name, id] = event.topic;
      if (name === undefined || id === undefined) {
        continue;
      }
      events += 1;
      const goalId = scValToNative(id) as bigint;
      if (scValToNative(name) === 'goal_closed') {
        closed.add(goalId);
      } else {
        const data = scValToNative(event.value) as { integrator?: unknown };
        if (typeof data.integrator === 'string' && serves(data.integrator)) {
          created.add(goalId);
        }
      }
    }
    if (pages >= MAX_PAGES) {
      break;
    }
    // A retried page resumes from the last cursor received.
    const cursor = page.cursor;
    const next = await withRetries('getEvents', () =>
      server.getEvents({ cursor, filters, limit: PAGE_LIMIT }),
    );
    pages += 1;
    // An empty page is not the end: only a cursor that stops moving is.
    if (next.cursor === page.cursor && next.events.length === 0) {
      page = next;
      break;
    }
    page = next;
  }

  const goals = new Map<bigint, Goal>();
  for (const owner of options.owners ?? []) {
    const own = await loktin.read<RawGoal[]>('target-savings', 'user_goals', {
      owner,
    });
    for (const goal of own.map(toGoal)) {
      if (serves(goal.integrator)) {
        goals.set(goal.id, goal);
      }
    }
  }
  for (const id of created) {
    if (closed.has(id) || goals.has(id)) {
      continue;
    }
    try {
      goals.set(
        id,
        toGoal(await loktin.read<RawGoal>('target-savings', 'goal', { id })),
      );
    } catch (error) {
      // Closed since its last event was indexed.
      if (!(
        error instanceof ContractError && error.errorName === 'GoalNotFound'
      )) {
        throw error;
      }
    }
  }
  return {
    goals: [...goals.values()],
    events,
    pages,
    fromLedger: startLedger,
    toLedger: page.latestLedger,
  };
}

/**
 * Whether a goal can be collected at `now`, from its stored data (W97): a
 * period has started and is not the last one collected, the deadline has
 * not passed, and the target is not reached.
 */
export function isDue(goal: Goal, now: Date): boolean {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const start = Math.floor(goal.start.getTime() / 1000);
  const deadline = Math.floor(goal.deadline.getTime() / 1000);
  if (nowSeconds < start || goal.cadenceSeconds <= 0) {
    return false;
  }
  const period = BigInt(Math.floor((nowSeconds - start) / goal.cadenceSeconds));
  return (
    period > 0n &&
    period !== goal.lastCollectedPeriod &&
    nowSeconds <= deadline &&
    goal.principal < goal.target
  );
}

/** A transaction refused because its fee is above the keeper's ceiling (E10). */
export class FeeAboveCeilingError extends Error {
  override readonly name = 'FeeAboveCeilingError';
  readonly fee: bigint;
  readonly ceiling: bigint;

  constructor(fee: bigint, ceiling: bigint) {
    super(
      `the transaction fee, ${fee.toString()} stroops, is above the ceiling of ${ceiling.toString()} stroops`,
    );
    this.fee = fee;
    this.ceiling = ceiling;
  }
}

/**
 * Wraps a signer so it reads each transaction's total fee before signing,
 * and refuses one above `maxFeeStroops` (E10, W98). The SDK simulates before
 * it signs, so the fee read is the final one.
 */
export function feeCeilingSigner(
  signTransaction: SignTransaction,
  maxFeeStroops: bigint,
  networkPassphrase: string,
): SignTransaction {
  return async (xdr, opts) => {
    const fee = BigInt(TransactionBuilder.fromXdr(xdr, networkPassphrase).fee);
    if (fee > maxFeeStroops) {
      throw new FeeAboveCeilingError(fee, maxFeeStroops);
    }
    return signTransaction(xdr, opts);
  };
}

/** The contract errors a keeper logs as skips, by name (E7). */
export const SKIPPED_ERRORS: ReadonlySet<string> = new Set([
  'NotDue',
  'AlreadyCollected',
  'DeadlinePassed',
  'TargetReached',
  'Shortfall',
  'GoalNotFound',
  'EnforcedPause',
]);

/** The skip reason for an error, or undefined when the error must stop the pass. */
export function skipReason(error: unknown): string | undefined {
  if (error instanceof ContractError && SKIPPED_ERRORS.has(error.errorName)) {
    return error.errorName;
  }
  if (
    error instanceof SignerRefusedError &&
    error.cause instanceof FeeAboveCeilingError
  ) {
    return 'FeeAboveCeiling';
  }
  return undefined;
}

/** What a pass did with one goal (E8). */
export type GoalResult =
  | {
      readonly goalId: bigint;
      readonly action: 'collected';
      readonly hash: string;
      readonly ledger: number;
      readonly amount: bigint;
    }
  | {
      readonly goalId: bigint;
      readonly action: 'skipped';
      readonly reason: string;
    }
  | { readonly goalId: bigint; readonly action: 'not-due' };

/** One keeper pass (E5). */
export interface PassResult {
  readonly scan: ScanResult;
  readonly results: readonly GoalResult[];
  /** Set when an unexpected error stopped the pass (E7). */
  readonly failure?: {
    readonly goalId: bigint;
    readonly code: string;
    readonly message: string;
    /** The transaction to look up, when it was sent (PENDING) or failed. */
    readonly hash?: string;
  };
}

/** Options for {@link runPass}. */
export interface PassOptions extends ScanOptions {
  /** The clock used to decide which goals are due. Defaults to the device clock. */
  readonly now?: () => Date;
}

/**
 * One keeper pass (E1, E5, W97): scans the goals, then collects each due
 * goal, one at a time, with the configured signer. The expected refusals
 * and a fee above the ceiling are skips; any other error stops the pass.
 */
export async function runPass(
  loktin: Loktin,
  options: PassOptions,
): Promise<PassResult> {
  const scan = await scanGoals(loktin, options);
  const now = options.now ?? (() => new Date());
  const results: GoalResult[] = [];
  for (const goal of scan.goals) {
    if (!isDue(goal, now())) {
      results.push({ goalId: goal.id, action: 'not-due' });
      continue;
    }
    // collect takes one deposit, or what is left of the target.
    const left = goal.target - goal.principal;
    const amount = goal.depositSize < left ? goal.depositSize : left;
    try {
      const written = await loktin.write('target-savings', 'collect', {
        goal_id: goal.id,
      });
      results.push({
        goalId: goal.id,
        action: 'collected',
        hash: written.hash,
        ledger: written.ledger,
        amount,
      });
    } catch (error) {
      const reason = skipReason(error);
      if (reason === undefined) {
        return {
          scan,
          results,
          failure: {
            goalId: goal.id,
            code:
              typeof error === 'object' && error !== null && 'code' in error
                ? String(error.code)
                : 'UNEXPECTED',
            message: error instanceof Error ? error.message : String(error),
            ...(error instanceof PendingError ||
            error instanceof TransactionFailedError
              ? { hash: error.hash }
              : {}),
          },
        };
      }
      results.push({ goalId: goal.id, action: 'skipped', reason });
    }
  }
  return { scan, results };
}
