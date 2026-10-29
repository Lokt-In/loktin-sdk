// The keeper's log lines (E8): one per goal, a failed line when a pass
// stops, and a summary. Public keys and hashes only, never a secret.
import type { PassResult } from '@loktin/sdk/keeper';

export type LogLine = Readonly<Record<string, unknown>>;

export function reportLines(pass: PassResult, keeper: string): LogLine[] {
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
      goalId: pass.failure.goalId,
      action: 'failed',
      reason: `${pass.failure.code}: ${pass.failure.message}`,
      // Set for a sent or failed transaction, so it can be looked up.
      hash: pass.failure.hash ?? null,
      ledger: null,
      amount: null,
    });
  }
  const count = (action: string) =>
    pass.results.filter((result) => result.action === action).length;
  lines.push({
    summary: true,
    keeper,
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
