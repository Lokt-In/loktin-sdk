// The keeper core (E1, W97) on the local network: a goal is not due before
// its first period, a fee above the ceiling is skipped, a due goal is
// collected once, and a second pass in the same period finds it not due.
// Three goals of one owner, each with the default allowance, are all
// collected (W116). Then at scale (W112, W113): two channels collect about
// 25 due goals of two owners, the batched read matches goal(), and a
// channel list with a missing account fails before anything is sent.
import { Keypair, Transaction } from '@stellar/stellar-sdk/base';
import { basicNodeSigner } from '@stellar/stellar-sdk/contract';
import { Api, Server } from '@stellar/stellar-sdk/rpc';
import { type Loktin, createLoktin, toBaseUnits } from '@loktin/sdk';
import { feeCeilingSigner, runPass, scanGoals } from '@loktin/sdk/keeper';
import { TargetSavings } from '@loktin/sdk/target-savings';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  MIN_CADENCE,
  NETWORK,
  PASSPHRASE,
  context,
  freshIntegrator,
  network,
  sdkFor,
  sleep,
  stellar,
} from './context.js';

const ctx = context();
const user = sdkFor(ctx, 'user');
// A fresh integrator, so the keeper serves this file's goal only.
const integrator = freshIntegrator();
const savings = new TargetSavings(user, { integrator, integratorFeeBps: 0 });
// The keeper signs with the setup's integrator account, which holds XLM.
const keeperKey = Keypair.fromSecret(ctx.secrets.integrator);

function keeper(maxFeeStroops: bigint) {
  return createLoktin({
    network: network(ctx),
    publicKey: keeperKey.publicKey(),
    signer: {
      signTransaction: feeCeilingSigner(
        basicNodeSigner(keeperKey, PASSPHRASE).signTransaction,
        maxFeeStroops,
        PASSPHRASE,
      ),
    },
  });
}
const pass = (maxFeeStroops = 10_000_000n) =>
  runPass(keeper(maxFeeStroops), { integrators: [integrator] });
const balance = () =>
  user.read<bigint>('token', 'balance', { id: ctx.addresses.user });

describe('the keeper on a local network', () => {
  let goalId = 0n;

  beforeAll(async () => {
    const created = await savings.createGoal({
      target: toBaseUnits('10'),
      deadline: new Date(Date.now() + 10 * MIN_CADENCE * 1000),
      cadenceSeconds: MIN_CADENCE,
      depositSize: toBaseUnits('1'),
      rule: { kind: 'lock' },
    });
    goalId = created.result;
  });

  it('finds the goal not due before its first period', async () => {
    const result = await pass();
    expect(result.failure).toBeUndefined();
    expect(result.results).toEqual([{ goalId, action: 'not-due' }]);
    expect(result.scan.pages).toBeGreaterThanOrEqual(1);
  });

  it('skips a due goal whose fee is above the ceiling', async () => {
    const { start } = await savings.goal(goalId);
    const due = start.getTime() + MIN_CADENCE * 1000;
    await sleep(Math.max(0, due - Date.now()) + 6000);
    const result = await pass(1n);
    expect(result.results).toEqual([
      { goalId, action: 'skipped', reason: 'FeeAboveCeiling' },
    ]);
    await expect(savings.goal(goalId)).resolves.toMatchObject({
      principal: 0n,
      lastCollectedPeriod: 0n,
    });
  });

  it('collects the due goal, moving the balance and principal by the deposit', async () => {
    const before = await balance();
    const result = await pass();
    expect(result.failure).toBeUndefined();
    expect(result.results).toEqual([
      expect.objectContaining({
        goalId,
        action: 'collected',
        amount: toBaseUnits('1'),
      }),
    ]);
    expect(before - (await balance())).toBe(toBaseUnits('1'));
    await expect(savings.goal(goalId)).resolves.toMatchObject({
      principal: toBaseUnits('1'),
      lastCollectedPeriod: 1n,
    });
  });

  it('finds the goal not due again in the same period', async () => {
    // The goal's stored data shows the period is collected, so the pass
    // does not send a collect that AlreadyCollected would refuse.
    const result = await pass();
    expect(result.results).toEqual([{ goalId, action: 'not-due' }]);
    await expect(savings.goal(goalId)).resolves.toMatchObject({
      principal: toBaseUnits('1'),
    });
  });
});

/** An SDK instance that signs as a throwaway key. */
function signingAs(secret: string): Loktin {
  const keypair = Keypair.fromSecret(secret);
  return createLoktin({
    network: network(ctx),
    publicKey: keypair.publicKey(),
    signer: basicNodeSigner(keypair, PASSPHRASE),
  });
}

/**
 * A new funded account in the temporary CLI config, optionally holding
 * TEST. Returns its secret, which is never printed.
 */
async function newAccount(name: string, test?: string): Promise<string> {
  const cli = (args: readonly string[]) => stellar(ctx.configDir, args);
  const onLocal = ['--network', NETWORK];
  await cli(['keys', 'generate', name, ...onLocal, '--fund']);
  if (test !== undefined) {
    await cli([
      'tx',
      'new',
      'change-trust',
      '--line',
      ctx.asset,
      '--source-account',
      name,
      ...onLocal,
    ]);
    await cli([
      'tx',
      'new',
      'payment',
      '--destination',
      await cli(['keys', 'public-key', name]),
      '--asset',
      ctx.asset,
      '--amount',
      test,
      '--source-account',
      'issuer',
      ...onLocal,
    ]);
  }
  return cli(['keys', 'secret', name]);
}

describe('the keeper at scale on a local network', () => {
  // A fresh integrator, so these passes serve these goals only.
  const scaleIntegrator = freshIntegrator();
  const options = { integrators: [scaleIntegrator] };
  const goalsPerOwner = [13, 12];
  let channels: Loktin[] = [];
  let owners: TargetSavings[] = [];
  const goalIds: bigint[] = [];
  let lastStart = 0;

  beforeAll(async () => {
    // Two owners with 1,000 TEST each, and a second keeper account. One at
    // a time: the TEST payments all come from the issuer's account.
    const ownerA = await newAccount('keeper-owner-a', '10000000000');
    const ownerB = await newAccount('keeper-owner-b', '10000000000');
    const channelB = await newAccount('keeper-channel-b');
    channels = [keeper(10_000_000n), signingAs(channelB)];
    const ownerSdks = [ownerA, ownerB].map(signingAs);
    owners = ownerSdks.map(
      (sdk) =>
        new TargetSavings(sdk, {
          integrator: scaleIntegrator,
          integratorFeeBps: 0,
        }),
    );
    // Each owner creates its goals one at a time; the owners in parallel.
    // The token allowance is one per owner, and each approval replaces the
    // last, so only the last goal approves, for all of the owner's goals.
    const created = await Promise.all(
      owners.map(async (savings, index) => {
        const count = goalsPerOwner[index] ?? 0;
        const { latestLedger } = await (
          ownerSdks[index] as Loktin
        ).ledgerInfo();
        const ids: bigint[] = [];
        for (let i = 0; i < count; i++) {
          const goal = await savings.createGoal({
            target: toBaseUnits('10'),
            deadline: new Date(Date.now() + 15 * MIN_CADENCE * 1000),
            cadenceSeconds: MIN_CADENCE,
            depositSize: toBaseUnits('1'),
            rule: { kind: 'lock' },
            allowance:
              i < count - 1
                ? 'none'
                : {
                    amount: BigInt(count) * toBaseUnits('10'),
                    expiryLedger: latestLedger + 20_000,
                  },
          });
          ids.push(goal.result);
        }
        return ids;
      }),
    );
    goalIds.push(...created.flat());
    const first = owners[0];
    if (first === undefined) {
      throw new Error('no owner');
    }
    for (const id of goalIds) {
      const { start } = await first.goal(id);
      lastStart = Math.max(lastStart, start.getTime());
    }
  }, 600_000);

  it('fails before anything is sent when a channel account does not exist', async () => {
    expect(goalIds).toHaveLength(25);
    // Wait until every goal's first period has started.
    await sleep(
      Math.max(0, lastStart + MIN_CADENCE * 1000 - Date.now()) + 6000,
    );
    const missing = Keypair.random();
    const result = await runPass(
      [
        channels[0] as Loktin,
        createLoktin({
          network: network(ctx),
          publicKey: missing.publicKey(),
          signer: basicNodeSigner(missing, PASSPHRASE),
        }),
      ],
      options,
    );
    expect(result.results).toEqual([]);
    expect(result.failure).toEqual({
      channel: missing.publicKey(),
      code: 'INVALID_INPUT',
      message: `the channel account ${missing.publicKey()} does not exist`,
    });
    const scan = await scanGoals(channels[0] as Loktin, options);
    expect(scan.goals).toHaveLength(25);
    for (const goal of scan.goals) {
      expect(goal).toMatchObject({ principal: 0n, lastCollectedPeriod: 0n });
    }
  });

  it('collects every due goal with two channels, each sending at least one', async () => {
    const result = await runPass(channels, options);
    expect(result.failure).toBeUndefined();
    expect(result.results).toHaveLength(25);
    expect(result.results.filter((r) => r.action !== 'collected')).toEqual([]);
    expect(new Set(result.results.map((r) => r.goalId))).toEqual(
      new Set(goalIds),
    );
    const server = new Server(ctx.rpcUrl, { allowHttp: true });
    const senders = new Map<string, number>();
    for (const goal of result.results) {
      expect(goal.action).toBe('collected');
      if (goal.action !== 'collected') {
        continue;
      }
      const sent = await server.getTransaction(goal.hash);
      if (sent.status !== Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`transaction ${goal.hash} is ${sent.status}`);
      }
      const source = new Transaction(sent.envelopeXdr, PASSPHRASE).source;
      senders.set(source, (senders.get(source) ?? 0) + 1);
    }
    expect([...senders.keys()].sort()).toEqual(
      channels.map((channel) => channel.config.publicKey).sort(),
    );
    for (const count of senders.values()) {
      expect(count).toBeGreaterThanOrEqual(1);
    }
  });

  it('reads the goals in a batch exactly as goal() reads them', async () => {
    const scan = await scanGoals(channels[0] as Loktin, options);
    expect(scan.goals).toHaveLength(25);
    const reader = owners[0] as TargetSavings;
    for (const goal of scan.goals) {
      expect(goal).toEqual(await reader.goal(goal.id));
      // One deposit each. The earliest goals may have been collected in
      // their second period, since creating them all takes about 35 s.
      expect(goal.principal).toBe(toBaseUnits('1'));
      expect(goal.lastCollectedPeriod).toBeGreaterThanOrEqual(1n);
    }
  });
});

describe("the default allowance covers all of an owner's goals", () => {
  const integratorC = freshIntegrator();
  let savings: TargetSavings;
  const ids: bigint[] = [];
  let lastStart = 0;

  beforeAll(async () => {
    const owner = await newAccount('keeper-owner-c', '1000000000');
    savings = new TargetSavings(signingAs(owner), {
      integrator: integratorC,
      integratorFeeBps: 0,
    });
    // One after another, each with the default 'auto' allowance.
    for (let i = 0; i < 3; i++) {
      const goal = await savings.createGoal({
        target: toBaseUnits('10'),
        deadline: new Date(Date.now() + 15 * MIN_CADENCE * 1000),
        cadenceSeconds: MIN_CADENCE,
        depositSize: toBaseUnits('1'),
        rule: { kind: 'lock' },
      });
      ids.push(goal.result);
      // Each approval covers the goals before it and the new one.
      expect(goal.allowance?.amount).toBe(BigInt(i + 1) * toBaseUnits('10'));
    }
    for (const id of ids) {
      lastStart = Math.max(lastStart, (await savings.goal(id)).start.getTime());
    }
  }, 300_000);

  it('collects all three in one pass, with no skip', async () => {
    await sleep(
      Math.max(0, lastStart + MIN_CADENCE * 1000 - Date.now()) + 6000,
    );
    const result = await runPass(keeper(10_000_000n), {
      integrators: [integratorC],
    });
    expect(result.failure).toBeUndefined();
    expect(result.results).toHaveLength(3);
    expect(result.results.filter((r) => r.action !== 'collected')).toEqual([]);
    for (const id of ids) {
      await expect(savings.goal(id)).resolves.toMatchObject({
        principal: toBaseUnits('1'),
      });
    }
  });
});
