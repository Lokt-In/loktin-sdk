import type { PassResult } from '@loktin/sdk/keeper';
import { describe, expect, it } from 'vitest';
import { reportLines, toLine } from '../src/report.ts';

const KEEPER = 'GBMV4UX5WH7N5THS365Y5YL244FYK4W75S25VBOL2FQQSX2KAI4PQ4BX';
const HASH = 'ab'.repeat(32);

function pass(change: Partial<PassResult>): PassResult {
  return {
    scan: {
      goals: [],
      events: 9,
      pages: 14,
      fromLedger: 5_436_569,
      toLedger: 5_557_530,
    },
    results: [],
    ...change,
  };
}

describe('the keeper log lines', () => {
  it('give the hash of a pending failure, so it can be looked up', () => {
    const lines = reportLines(
      pass({
        results: [{ goalId: 7n, action: 'not-due' }],
        failure: {
          goalId: 8n,
          code: 'PENDING',
          message: 'transaction was sent and its outcome is not known yet.',
          hash: HASH,
        },
      }),
      KEEPER,
    );
    expect(lines[1]).toEqual({
      goalId: 8n,
      action: 'failed',
      reason: 'PENDING: transaction was sent and its outcome is not known yet.',
      hash: HASH,
      ledger: null,
      amount: null,
    });
    expect(toLine(lines[1] ?? {})).toContain(`"hash":"${HASH}"`);
    expect(lines[2]).toMatchObject({ summary: true, failed: 1, notDue: 1 });
  });

  it('have no hash for a failure before anything was sent', () => {
    const lines = reportLines(
      pass({
        failure: { goalId: 8n, code: 'NETWORK', message: 'fetch failed' },
      }),
      KEEPER,
    );
    expect(lines[0]).toMatchObject({ action: 'failed', hash: null });
  });

  it('end with the summary', () => {
    const lines = reportLines(
      pass({
        results: [
          {
            goalId: 1n,
            action: 'collected',
            hash: HASH,
            ledger: 5_557_000,
            amount: 10_000_000n,
          },
          { goalId: 2n, action: 'skipped', reason: 'Shortfall' },
        ],
      }),
      KEEPER,
    );
    expect(lines.map((line) => toLine(line))).toEqual([
      `{"goalId":"1","action":"collected","reason":null,"hash":"${HASH}","ledger":5557000,"amount":"10000000"}`,
      '{"goalId":"2","action":"skipped","reason":"Shortfall","hash":null,"ledger":null,"amount":null}',
      `{"summary":true,"keeper":"${KEEPER}","goalsFound":0,"collected":1,"skipped":1,"notDue":0,"failed":0,"events":9,"pages":14,"fromLedger":5436569,"toLedger":5557530}`,
    ]);
  });
});
