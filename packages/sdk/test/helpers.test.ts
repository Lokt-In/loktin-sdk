import { describe, expect, it } from 'vitest';
import { InvalidInputError, windowInTimeZone } from '../src/index.js';
import { effectiveWithdrawalDay } from '../src/spend-save/index.js';
import {
  type ScheduledAllowanceInput,
  creationBreakdown,
  scheduledAllowance,
} from '../src/target-savings/index.js';

const NOW_S = Date.UTC(2026, 10, 1) / 1000;
const DAY = 86_400;
const WEEK = 7 * DAY;
const LEDGER = 1_000_000;
const MAX_TTL = 3_110_400;
const at = (seconds: number) => new Date(seconds * 1000);

// A new goal: it starts now, and nothing has been collected.
function newGoal(
  change: Partial<ScheduledAllowanceInput>,
): ScheduledAllowanceInput {
  return {
    now: at(NOW_S),
    ledger: LEDGER,
    maxEntryTtl: MAX_TTL,
    start: at(NOW_S),
    deadline: at(NOW_S + 10 * WEEK),
    cadenceSeconds: WEEK,
    depositSize: 100n,
    target: 1_000_000n,
    principal: 0n,
    lastCollectedPeriod: 0n,
    ...change,
  };
}

describe('scheduledAllowance', () => {
  it('counts the period that falls due on the deadline second', () => {
    const onBoundary = scheduledAllowance(
      newGoal({ deadline: at(NOW_S + 5 * DAY), cadenceSeconds: DAY }),
    );
    expect(onBoundary).toMatchObject({ periods: 5n, amount: 500n });
    const justBefore = scheduledAllowance(
      newGoal({ deadline: at(NOW_S + 5 * DAY - 1), cadenceSeconds: DAY }),
    );
    expect(justBefore).toMatchObject({ periods: 4n, amount: 400n });
  });

  it('has nothing to collect one second after the deadline, even inside its period', () => {
    // The deadline falls in the middle of period 5.
    const deadline = NOW_S - 1;
    const start = deadline - 5.5 * DAY;
    expect(
      scheduledAllowance(
        newGoal({
          start: at(start),
          deadline: at(deadline),
          cadenceSeconds: DAY,
          lastCollectedPeriod: 4n,
        }),
      ),
    ).toMatchObject({ periods: 0n, amount: 0n });
  });

  it('still counts the period due on the deadline second when now is the deadline', () => {
    const start = NOW_S - 5 * DAY;
    expect(
      scheduledAllowance(
        newGoal({
          start: at(start),
          deadline: at(NOW_S),
          cadenceSeconds: DAY,
          lastCollectedPeriod: 4n,
        }),
      ),
    ).toMatchObject({ periods: 1n, amount: 100n });
  });

  it('expires one day of ledgers after the deadline when the goal is shorter than the cap', () => {
    const allowance = scheduledAllowance(newGoal({}));
    const expiryLedger = LEDGER + (10 * WEEK) / 5 + 17_280;
    expect(allowance).toEqual({
      amount: 1000n,
      expiryLedger,
      expiresAt: at(NOW_S + (expiryLedger - LEDGER) * 5),
      periods: 10n,
    });
    expect(allowance.renewBy).toBeUndefined();
  });

  it('caps the expiry for a goal longer than the cap, counts up to the expiry, and asks for renewal', () => {
    const allowance = scheduledAllowance(
      newGoal({ deadline: at(NOW_S + 365 * DAY) }),
    );
    const expiryLedger = LEDGER + MAX_TTL - 1;
    const expiresAt = NOW_S + (MAX_TTL - 1) * 5;
    // 15,551,995 seconds hold 25 whole weeks.
    expect(allowance).toEqual({
      amount: 2500n,
      expiryLedger,
      expiresAt: at(expiresAt),
      periods: 25n,
      renewBy: at(expiresAt - 7 * DAY),
    });
  });

  it('caps the amount at what the goal still needs', () => {
    const allowance = scheduledAllowance(
      newGoal({ target: 1000n, principal: 950n }),
    );
    expect(allowance).toMatchObject({ periods: 10n, amount: 50n });
    expect(
      scheduledAllowance(newGoal({ target: 1000n, principal: 1000n })),
    ).toMatchObject({ amount: 0n });
  });

  it('starts after the last collected period, and skips missed ones', () => {
    // Three and a half weeks in, of a ten-week goal.
    const start = NOW_S - 3.5 * WEEK;
    const goal = { start: at(start), deadline: at(start + 10 * WEEK) };
    expect(
      scheduledAllowance(newGoal({ ...goal, lastCollectedPeriod: 3n })),
    ).toMatchObject({ periods: 7n, amount: 700n });
    // Periods 2 and 3 were missed and are never collected: period 3 is due now.
    expect(
      scheduledAllowance(newGoal({ ...goal, lastCollectedPeriod: 1n })),
    ).toMatchObject({ periods: 8n, amount: 800n });
  });

  it('refuses inputs it cannot count with', () => {
    expect(() => scheduledAllowance(newGoal({ cadenceSeconds: 0 }))).toThrow(
      InvalidInputError,
    );
    expect(() =>
      scheduledAllowance(newGoal({ deadline: new Date(Number.NaN) })),
    ).toThrow(InvalidInputError);
  });
});

describe('creationBreakdown', () => {
  it('rounds each part down, as the contract does', () => {
    // 999 × 333 / 10,000 = 33.27; × 37 = 3.70; × 11 = 1.10.
    expect(
      creationBreakdown({
        target: 999n,
        rule: { kind: 'penalty', bps: 333 },
        loktinFeeBps: 37,
        integratorFeeBps: 11,
      }),
    ).toEqual({
      amount: 999n,
      penalty: 33n,
      loktinFee: 3n,
      integratorFee: 1n,
      toUser: 962n,
      locked: false,
    });
  });

  it('works at the caps, and refuses a rate above one', () => {
    const atCaps = {
      target: 12_345n,
      rule: { kind: 'penalty', bps: 1000 },
      loktinFeeBps: 100,
      integratorFeeBps: 100,
    } as const;
    expect(creationBreakdown(atCaps)).toEqual({
      amount: 12_345n,
      penalty: 1234n,
      loktinFee: 123n,
      integratorFee: 123n,
      toUser: 10_865n,
      locked: false,
    });
    expect(() =>
      creationBreakdown({ ...atCaps, rule: { kind: 'penalty', bps: 1001 } }),
    ).toThrow(/RateAboveCap/);
    expect(() => creationBreakdown({ ...atCaps, loktinFeeBps: 101 })).toThrow(
      /RateAboveCap/,
    );
    expect(() =>
      creationBreakdown({ ...atCaps, integratorFeeBps: 101 }),
    ).toThrow(/RateAboveCap/);
  });

  it('has no penalty for a lock rule, and says the goal is locked', () => {
    expect(
      creationBreakdown({
        target: 10_000n,
        rule: { kind: 'lock' },
        loktinFeeBps: 25,
        integratorFeeBps: 50,
      }),
    ).toEqual({
      amount: 10_000n,
      penalty: 0n,
      loktinFee: 25n,
      integratorFee: 50n,
      toUser: 9925n,
      locked: true,
    });
  });
});

describe('effectiveWithdrawalDay', () => {
  // A change to day 20 from December 2026.
  const enrollment = {
    withdrawalDay: 5,
    pendingDay: { day: 20, fromMonth: 2026 * 12 + 11 },
  };

  it('keeps the stored day before the month boundary', () => {
    expect(
      effectiveWithdrawalDay(
        enrollment,
        new Date(Date.UTC(2026, 11, 1) - 1000),
      ),
    ).toBe(5);
  });

  it('applies the pending day at the boundary and after it', () => {
    expect(
      effectiveWithdrawalDay(enrollment, new Date(Date.UTC(2026, 11, 1))),
    ).toBe(20);
    expect(
      effectiveWithdrawalDay(enrollment, new Date(Date.UTC(2027, 0, 15))),
    ).toBe(20);
  });

  it('keeps the stored day with no pending change', () => {
    expect(
      effectiveWithdrawalDay(
        { withdrawalDay: 5, pendingDay: undefined },
        new Date(Date.UTC(2030, 0, 1)),
      ),
    ).toBe(5);
  });
});

describe('windowInTimeZone', () => {
  const window = {
    start: new Date(Date.UTC(2026, 11, 20)),
    end: new Date(Date.UTC(2026, 11, 21)),
  };

  it('formats the window in the given zone and locale', () => {
    const format = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Tokyo',
    });
    expect(
      windowInTimeZone(window, { timeZone: 'Asia/Tokyo', locale: 'en-GB' }),
    ).toEqual({
      start: format.format(window.start),
      end: format.format(window.end),
      timeZone: 'Asia/Tokyo',
    });
  });

  it("uses the device's zone when none is given", () => {
    expect(windowInTimeZone(window).timeZone).toBe(
      new Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });

  it('refuses a zone the runtime does not know', () => {
    expect(() => windowInTimeZone(window, { timeZone: 'Mars/Base' })).toThrow(
      InvalidInputError,
    );
  });
});
