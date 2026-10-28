import { StrKey } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import type { Goal } from '../src/target-savings/index.js';
import {
  EVIDENCE_RESERVE,
  type EvidenceGoalSpec,
  type Funding,
  MIN_XLM_STROOPS,
  USDC,
  findEvidenceGoal,
  formatUnits,
  isPhase,
  percentile,
  phaseBudget,
  preflightProblems,
  skimOf,
  stepRecord,
  summarise,
  tidyUpPlan,
} from '../smoke/helpers.ts';

const INTEGRATOR_A = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(1));
const INTEGRATOR_B = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(2));
const OWNER = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(3));

const SPEC: EvidenceGoalSpec = {
  integrator: INTEGRATOR_A,
  target: 5n * USDC,
  depositSize: 1n * USDC,
  cadenceSeconds: 86_400,
  rule: { kind: 'penalty', bps: 500 },
};

function goal(change: Partial<Goal>): Goal {
  return {
    id: 7n,
    owner: OWNER,
    integrator: INTEGRATOR_A,
    integratorFeeBps: 50,
    loktinFeeBps: 0,
    target: 5n * USDC,
    deadline: new Date(0),
    cadenceSeconds: 86_400,
    depositSize: 1n * USDC,
    rule: { kind: 'penalty', bps: 500 },
    start: new Date(0),
    principal: 0n,
    shares: 0n,
    lastCollectedPeriod: 0n,
    missedCount: 0n,
    ...change,
  };
}

describe('percentile and summarise', () => {
  it('use the nearest rank', () => {
    const values = Array.from({ length: 100 }, (_, i) => 100 - i);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 100)).toBe(100);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([3, 1, 2], 50)).toBe(2);
    expect(percentile([], 50)).toBeNaN();
  });

  it('summarise counts, p50, p95 and the maximum', () => {
    expect(summarise([400, 100, 300, 200])).toEqual({
      count: 4,
      p50Ms: 200,
      p95Ms: 400,
      maxMs: 400,
    });
  });
});

describe('the budget check', () => {
  it('skims as Spend & Save does', () => {
    // 5% of 1.25 is 0.0625, and rounding up to 1 USDC adds 0.75.
    expect(skimOf(12_500_000n, 500, USDC)).toBe(8_125_000n);
    expect(skimOf(2n * USDC, 500, USDC)).toBe(1_000_000n);
    expect(skimOf(2n * USDC, 1_000)).toBe(2_000_000n);
    // Never more than the spend.
    expect(skimOf(1n, 0, USDC)).toBe(1n);
  });

  it('works out each phase budget, with the evidence reserve in goals and run', () => {
    expect(phaseBudget('goals')).toEqual({
      userA: EVIDENCE_RESERVE,
      userB: EVIDENCE_RESERVE,
    });
    expect(phaseBudget('run')).toEqual({
      userA: 96_125_000n,
      userB: 72_500_000n,
    });
    expect(phaseBudget('window')).toEqual({ userA: 0n, userB: 0n });
  });

  it('reports every shortfall by alias, and nothing when all is funded', () => {
    const funded = (
      role: Funding['role'],
      usdc: bigint | undefined,
    ): Funding => ({
      role,
      alias: `alias-${role}`,
      xlm: MIN_XLM_STROOPS,
      usdc,
    });
    const budget = phaseBudget('run');
    expect(
      preflightProblems(
        [
          funded('userA', budget.userA),
          funded('userB', budget.userB),
          funded('integratorA', 0n),
          funded('integratorB', 0n),
        ],
        budget,
      ),
    ).toEqual([]);
    expect(
      preflightProblems(
        [
          { ...funded('userA', budget.userA - 1n), xlm: MIN_XLM_STROOPS - 1n },
          { ...funded('userB', budget.userB), xlm: undefined },
          funded('integratorA', undefined),
          funded('integratorB', 0n),
        ],
        budget,
      ),
    ).toEqual([
      'alias-userA (userA): 9.9999999 XLM, needs at least 10 XLM',
      'alias-userA (userA): 9.6124999 USDC, needs 9.6125 USDC',
      'alias-userB (userB): no account on this network',
      'alias-integratorA (integratorA): no USDC trustline',
    ]);
  });

  it('formats 7-decimal amounts', () => {
    expect(formatUnits(96_125_000n)).toBe('9.6125');
    expect(formatUnits(50_000_000n)).toBe('5');
    expect(formatUnits(1n)).toBe('0.0000001');
  });
});

describe('matching an existing evidence goal', () => {
  it('finds the goal with the same integrator, amounts, cadence and rule', () => {
    const match = goal({ id: 9n });
    expect(findEvidenceGoal([goal({ id: 8n, target: 1n }), match], SPEC)).toBe(
      match,
    );
  });

  it('skips goals that differ in any field', () => {
    for (const change of [
      { integrator: INTEGRATOR_B },
      { target: 4n * USDC },
      { depositSize: 2n * USDC },
      { cadenceSeconds: 3_600 },
      { rule: { kind: 'penalty', bps: 1_000 } },
      { rule: { kind: 'lock' } },
    ] satisfies Partial<Goal>[]) {
      expect(findEvidenceGoal([goal(change)], SPEC)).toBeUndefined();
    }
    expect(
      findEvidenceGoal([goal({ rule: { kind: 'lock' } })], {
        ...SPEC,
        rule: { kind: 'lock' },
      }),
    ).toBeDefined();
  });
});

describe('the evidence step record', () => {
  it('keeps signing out of the write time, and links to stellar.expert', () => {
    expect(
      stepRecord({
        label: 'userA deposits',
        call: 'targetSavings.deposit',
        actor: 'loktin-smoke-user-a',
        hash: 'ab'.repeat(32),
        ledger: 123,
        feeCharged: 104_321n,
        totalMs: 1_234.6,
        signingMs: 14.2,
      }),
    ).toEqual({
      label: 'userA deposits',
      call: 'targetSavings.deposit',
      actor: 'loktin-smoke-user-a',
      hash: 'ab'.repeat(32),
      ledger: 123,
      feeCharged: '104321',
      timeMs: 1_220,
      signingMs: 14,
      explorer: `https://stellar.expert/explorer/testnet/tx/${'ab'.repeat(32)}`,
    });
  });

  it('knows the three phases', () => {
    expect(['goals', 'run', 'window'].every(isPhase)).toBe(true);
    expect(isPhase('deploy')).toBe(false);
    expect(isPhase(undefined)).toBe(false);
  });
});

describe('the tidy-up plan of a rerun', () => {
  const NOW = new Date(Date.UTC(2026, 9, 28, 12));
  const later = new Date(NOW.getTime() + 86_400_000);
  const earlier = new Date(NOW.getTime() - 1000);
  // A left-over flow goal, open until tomorrow.
  const flow = (change: Partial<Goal>) =>
    goal({
      integrator: INTEGRATOR_B,
      target: 2n * USDC,
      deadline: later,
      ...change,
    });

  it('leaves the evidence goal alone and closes every other goal', () => {
    const evidence = goal({ id: 1n, deadline: later });
    const { evidence: found, actions } = tidyUpPlan(
      [
        evidence,
        flow({ id: 2n, principal: 0n }),
        flow({ id: 3n, principal: 2n * USDC }),
        flow({ id: 4n, principal: USDC, deadline: NOW }),
        flow({
          id: 5n,
          principal: USDC,
          deadline: earlier,
          rule: { kind: 'lock' },
        }),
        flow({
          id: 6n,
          principal: USDC,
          rule: { kind: 'penalty', bps: 1_000 },
        }),
        flow({ id: 7n, principal: 3n * (USDC / 10n), rule: { kind: 'lock' } }),
      ],
      SPEC,
      NOW,
    );
    expect(found).toBe(evidence);
    expect(actions).toEqual([
      { kind: 'withdraw', goalId: 2n, reason: 'empty' },
      { kind: 'withdraw', goalId: 3n, reason: 'at its target' },
      // At the deadline second and after it, no penalty and no lock apply.
      { kind: 'withdraw', goalId: 4n, reason: 'at or past its deadline' },
      { kind: 'withdraw', goalId: 5n, reason: 'at or past its deadline' },
      { kind: 'withdraw', goalId: 6n, reason: 'early, with its penalty' },
      // 0.3 of 2 deposited: 1.7 fills it.
      { kind: 'fill-then-withdraw', goalId: 7n, amount: 17n * (USDC / 10n) },
    ]);
  });

  it('a lone evidence goal needs nothing', () => {
    const evidence = goal({ deadline: later, principal: 2n * USDC });
    expect(tidyUpPlan([evidence], SPEC, NOW)).toEqual({
      evidence,
      actions: [],
    });
  });

  it('reports a missing evidence goal, and still plans the rest', () => {
    const plan = tidyUpPlan(
      [flow({ id: 2n, principal: 0n }), goal({ id: 3n, target: 4n * USDC })],
      SPEC,
      NOW,
    );
    expect(plan.evidence).toBeUndefined();
    expect(plan.actions.map((action) => action.goalId)).toEqual([2n, 3n]);
  });
});
