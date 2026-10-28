// W75: goal creations by different users in the same ledger all succeed.
// Up to 0.2.0, all but one of them failed, because each was saved under the
// shared next id read at run time.
import { Keypair } from '@stellar/stellar-sdk/base';
import { basicNodeSigner } from '@stellar/stellar-sdk/contract';
import { createLoktin, toBaseUnits } from '@loktin/sdk';
import { TargetSavings } from '@loktin/sdk/target-savings';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  MIN_CADENCE,
  NETWORK,
  PASSPHRASE,
  context,
  freshIntegrator,
  network,
  stellar,
} from './context.js';

const ctx = context();
const USERS = 10;
const integrator = freshIntegrator();
const modules: TargetSavings[] = [];

describe('goal creations in the same ledger', () => {
  beforeAll(async () => {
    for (let index = 0; index < USERS; index++) {
      const alias = `concurrent-${String(index)}`;
      await stellar(ctx.configDir, [
        'keys',
        'generate',
        alias,
        '--network',
        NETWORK,
        '--fund',
      ]);
      // Kept in memory only, never printed.
      const keypair = Keypair.fromSecret(
        await stellar(ctx.configDir, ['keys', 'secret', alias]),
      );
      modules.push(
        new TargetSavings(
          createLoktin({
            network: network(ctx),
            publicKey: keypair.publicKey(),
            signer: basicNodeSigner(keypair, PASSPHRASE),
          }),
          { integrator, integratorFeeBps: 0 },
        ),
      );
    }
  });

  it('ten users each create a goal at the same moment, and all succeed', async () => {
    const deadline = new Date(Date.now() + 60 * MIN_CADENCE * 1000);
    const results = await Promise.allSettled(
      modules.map((targetSavings) =>
        targetSavings.createGoal({
          target: toBaseUnits('10'),
          deadline,
          cadenceSeconds: MIN_CADENCE,
          depositSize: toBaseUnits('1'),
          rule: { kind: 'lock' },
          allowance: 'none',
        }),
      ),
    );
    const failures = results.filter((result) => result.status === 'rejected');
    expect(failures).toEqual([]);
    const created = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    expect(new Set(created.map((goal) => goal.result)).size).toBe(USERS);
    // Some of them shared a ledger, which is the case that used to fail.
    expect(new Set(created.map((goal) => goal.ledger)).size).toBeLessThan(
      USERS,
    );
  });
});
