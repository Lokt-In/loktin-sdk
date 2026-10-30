// Read overhead (T10, W70): how much time the SDK adds to a read of its own,
// on the private local network only. Run with
//
//   npm run sizing:reads
//
// after `stellar contract build` and `npm run build`. It times 200 reads of
// one goal through the SDK and 200 simulations of the same call sent
// straight to the RPC with a transaction built once, in alternating blocks
// so that drift affects both. It prints the results and writes no file.
import {
  Account,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk/base';
import { Api, Server } from '@stellar/stellar-sdk/rpc';
import { createLoktin, toBaseUnits } from '@loktin/sdk';
import { TargetSavings } from '@loktin/sdk/target-savings';
import { expect, it } from 'vitest';
import {
  MIN_CADENCE,
  PASSPHRASE,
  context,
  freshIntegrator,
  network,
  sdkFor,
} from '../e2e/context.js';

const CALLS = 200;
const BLOCK = 20;
const WARM_UP = 10;
/** W70: the SDK adds no more than about 50 ms of its own to a read. */
const TARGET_MS = 50;

const ctx = context();

function percentile(sorted: readonly number[], p: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)] ?? Number.NaN;
}

function summary(times: readonly number[]): { p50: number; p95: number } {
  const sorted = [...times].sort((a, b) => a - b);
  const round = (ms: number) => Math.round(ms * 10) / 10;
  return {
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
  };
}

async function timed(call: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await call();
  return performance.now() - started;
}

it(`times ${String(CALLS)} reads through the SDK against ${String(CALLS)} direct simulations`, async () => {
  const server = new Server(ctx.rpcUrl, { allowHttp: true });
  // The guard in local-only.ts checked this already; check again here.
  expect((await server.getNetwork()).passphrase).toBe(PASSPHRASE);

  // One goal to read.
  const owner = new TargetSavings(sdkFor(ctx, 'user'), {
    integrator: freshIntegrator(),
    integratorFeeBps: 0,
  });
  const created = await owner.createGoal({
    target: toBaseUnits('10'),
    deadline: new Date(Date.now() + 10 * MIN_CADENCE * 1000),
    cadenceSeconds: MIN_CADENCE,
    depositSize: toBaseUnits('1'),
    rule: { kind: 'lock' },
    allowance: 'none',
  });
  const id = created.result;

  // The SDK: a read-only instance, as an app would use for reads.
  const reader = new TargetSavings(createLoktin({ network: network(ctx) }), {
    integrator: freshIntegrator(),
    integratorFeeBps: 0,
  });
  const throughSdk = () => reader.goal(id);

  // Direct: the same simulation, with a transaction built once.
  const tx = new TransactionBuilder(
    new Account(Keypair.random().publicKey(), '0'),
    { fee: '100', networkPassphrase: PASSPHRASE },
  )
    .addOperation(
      Operation.invokeContractFunction({
        contract: ctx.targetSavings,
        function: 'goal',
        args: [nativeToScVal(id, { type: 'u64' })],
      }),
    )
    .setTimeout(0)
    .build();
  const direct = async () => {
    const simulation = await server.simulateTransaction(tx);
    if (!Api.isSimulationSuccess(simulation)) {
      throw new Error('the direct simulation failed');
    }
  };

  // Both answer the same goal before anything is timed.
  expect((await throughSdk()).id).toBe(id);
  for (let i = 0; i < WARM_UP; i++) {
    await throughSdk();
    await direct();
  }

  const sdkTimes: number[] = [];
  const directTimes: number[] = [];
  for (let block = 0; block < CALLS / BLOCK; block++) {
    // Alternate which runs first, so drift affects both.
    const order =
      block % 2 === 0
        ? ([
            [throughSdk, sdkTimes],
            [direct, directTimes],
          ] as const)
        : ([
            [direct, directTimes],
            [throughSdk, sdkTimes],
          ] as const);
    for (const [call, times] of order) {
      for (let i = 0; i < BLOCK; i++) {
        times.push(await timed(call));
      }
    }
  }

  const sdk = summary(sdkTimes);
  const rpc = summary(directTimes);
  const added = {
    p50: Math.round((sdk.p50 - rpc.p50) * 10) / 10,
    p95: Math.round((sdk.p95 - rpc.p95) * 10) / 10,
  };
  console.log(
    JSON.stringify({
      calls: CALLS,
      block: BLOCK,
      sdk,
      direct: rpc,
      added,
      targetMs: TARGET_MS,
    }),
  );
  console.log(
    [
      '| Path | Calls | p50 (ms) | p95 (ms) |',
      '|---|---|---|---|',
      `| Through the SDK | ${String(sdkTimes.length)} | ${String(sdk.p50)} | ${String(sdk.p95)} |`,
      `| Direct simulation | ${String(directTimes.length)} | ${String(rpc.p50)} | ${String(rpc.p95)} |`,
      `| Added by the SDK | | ${String(added.p50)} | ${String(added.p95)} |`,
    ].join('\n'),
  );
  expect(sdkTimes).toHaveLength(CALLS);
  expect(directTimes).toHaveLength(CALLS);
});
