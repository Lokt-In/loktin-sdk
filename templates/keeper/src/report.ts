// The keeper's log lines (E8): one per goal, a failed line when a pass
// stops, and a summary. Public keys and hashes only, never a secret.
import type { PassResult } from '@loktin/sdk/keeper';

export type LogLine = Readonly<Record<string, unknown>>;

/**
 * The log lines of a pass. `channels` are the keys' public keys, in key file
 * order; the first is logged as `keeper`, so one key logs as before.
 */
export function reportLines(
  pass: PassResult,
  channels: readonly string[],
): LogLine[] {
  const lines: LogLine[] = pass.results.map((result) => ({
    goalId: result.goalId,
    action: result.action,
    reason: result.action === 'skipped' ? result.reason : null,
    hash: result.action === 'collected' ? result.hash : null,
    ledger: result.action === 'collected' ? result.ledger : null,
    amount: result.action === 'collected' ? result.amount : null,
  }));
  if (pass.failure !== undefined) {
    lines.push({
      // No goal id for a failure before any collect.
      goalId: pass.failure.goalId ?? null,
      action: 'failed',
      reason: `${pass.failure.code}: ${pass.failure.message}`,
      // Set for a sent or failed transaction, so it can be looked up.
      hash: pass.failure.hash ?? null,
      ledger: null,
      amount: null,
      channel: pass.failure.channel ?? null,
    });
  }
  const count = (action: string) =>
    pass.results.filter((result) => result.action === action).length;
  lines.push({
    summary: true,
    keeper: channels[0] ?? null,
    channels,
    goalsFound: pass.scan.goals.length,
    collected: count('collected'),
    skipped: count('skipped'),
    notDue: count('not-due'),
    failed: pass.failure === undefined ? 0 : 1,
    events: pass.scan.events,
    pages: pass.scan.pages,
    fromLedger: pass.scan.fromLedger,
    toLedger: pass.scan.toLedger,
  });
  return lines;
}

/** One JSON line, with bigints as decimal strings. */
export function toLine(record: LogLine): string {
  return JSON.stringify(record, (_, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
}
