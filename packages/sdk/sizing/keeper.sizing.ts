// Keeper sizing (E3, W72, W114): times full keeper sweeps over the same
// goals with 1, then 2, then 4 channel accounts, on the private local
// network only. Run with
//
//   npm run sizing:keeper [-- --goals N]
//
// after `stellar contract build` and `npm run build`. Every key is a
// throwaway on the local network, held in memory or in the e2e setup's
// temporary config, and never printed. At the full 2,000 goals the results
// go to docs/keeper-sizing.json; a smaller run prints its table only.
import { writeFile } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import {
  Asset,
  type FeeBumpTransaction,
  Keypair,
  Operation,
  type Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk/base';
import {
  type SignTransaction,
  basicNodeSigner,
} from '@stellar/stellar-sdk/contract';
import { Api, Server } from '@stellar/stellar-sdk/rpc';
import { type Loktin, createLoktin, toBaseUnits } from '@loktin/sdk';
import { type PassResult, runPass } from '@loktin/sdk/keeper';
import { TargetSavings } from '@loktin/sdk/target-savings';
import { expect, it } from 'vitest';
import {
  MIN_CADENCE,
  PASSPHRASE,
  context,
  freshIntegrator,
  network,
  sleep,
  stellar,
} from '../e2e/context.js';

const FULL_SIZE = 2000;
const GOALS = Number(process.env['KEEPER_SIZING_GOALS'] ?? FULL_SIZE);
/** Target Savings' MAX_OPEN_GOALS. */
const PER_OWNER = 20;
const CHANNEL_COUNTS = [1, 2, 4] as const;
/** Owners creating goals at once. */
const OWNERS_AT_ONCE = 25;
const DEPOSIT = toBaseUnits('1');
/** Each owner holds and approves enough for every collect, twice over. */
const OWNER_TEST = BigInt(PER_OWNER * CHANNEL_COUNTS.length * 2) * DEPOSIT;

const ctx = context();
const base = ctx.rpcUrl.replace(/\/rpc$/, '');

/** An RPC server that counts sends, and TRY_AGAIN_LATER answers. */
class CountingServer extends Server {
  sends = 0;
  tryAgainLater = 0;

  override async sendTransaction(
    tx: Transaction | FeeBumpTransaction,
  ): Promise<Api.SendTransactionResponse> {
    const response = await super.sendTransaction(tx);
    this.sends += 1;
    if (response.status === 'TRY_AGAIN_LATER') {
      this.tryAgainLater += 1;
    }
    return response;
  }
}

const server = new CountingServer(ctx.rpcUrl, { allowHttp: true });

/** Runs `work` on every item, at most `size` at a time. */
async function inPool<T>(
  items: readonly T[],
  size: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (let index = next++; index < items.length; index = next++) {
        await work(items[index] as T, index);
      }
    }),
  );
}

/** Builds, signs and sends a classic transaction, and waits for it. */
async function submit(
  source: Keypair,
  operations: readonly Parameters<TransactionBuilder['addOperation']>[0][],
  signers: readonly Keypair[] = [],
): Promise<void> {
  const account = await server.getAccount(source.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: '1000',
    networkPassphrase: PASSPHRASE,
  });
  for (const operation of operations) {
    builder.addOperation(operation);
  }
  const tx = builder.setTimeout(120).build();
  tx.sign(source, ...signers);
  const sent = await server.sendTransaction(tx);
  if (sent.status !== 'PENDING') {
    throw new Error(`a setup transaction was ${sent.status}`);
  }
  for (;;) {
    await sleep(1000);
    const got = await server.getTransaction(sent.hash);
    if (got.status === Api.GetTransactionStatus.SUCCESS) {
      return;
    }
    if (got.status === Api.GetTransactionStatus.FAILED) {
      throw new Error(`setup transaction ${sent.hash} failed`);
    }
  }
}

/** A signer that counts the transactions it signs. */
function counting(keypair: Keypair): {
  signTransaction: SignTransaction;
  signed: () => number;
} {
  const inner = basicNodeSigner(keypair, PASSPHRASE).signTransaction;
  let signed = 0;
  return {
    signTransaction: (xdr, opts) => {
      signed += 1;
      return inner(xdr, opts);
    },
    signed: () => signed,
  };
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) {
    out.push(items.slice(at, at + size));
  }
  return out;
}

interface Sweep {
  readonly channels: number;
  readonly goalsCollected: number;
  readonly skipped: Readonly<Record<string, number>>;
  readonly notDue: number;
  readonly failure: PassResult['failure'] | null;
  readonly sweepSeconds: number;
  readonly firstLedger: number;
  readonly lastLedger: number;
  readonly ledgersSpanned: number;
  readonly txPerLedger: number;
  readonly peakTxPerLedger: number;
  readonly sentPerChannel: readonly number[];
  readonly tryAgainLater: number;
  readonly scanPages: number;
  readonly scanEvents: number;
}

function sweepOf(
  channels: number,
  pass: PassResult,
  seconds: number,
  sentPerChannel: readonly number[],
  tryAgainLater: number,
): Sweep {
  const ledgers: number[] = [];
  const skipped: Record<string, number> = {};
  let notDue = 0;
  for (const result of pass.results) {
    if (result.action === 'collected') {
      ledgers.push(result.ledger);
    } else if (result.action === 'skipped') {
      skipped[result.reason] = (skipped[result.reason] ?? 0) + 1;
    } else {
      notDue += 1;
    }
  }
  const perLedger = new Map<number, number>();
  for (const ledger of ledgers) {
    perLedger.set(ledger, (perLedger.get(ledger) ?? 0) + 1);
  }
  const firstLedger = Math.min(...ledgers);
  const lastLedger = Math.max(...ledgers);
  const ledgersSpanned =
    ledgers.length === 0 ? 0 : lastLedger - firstLedger + 1;
  return {
    channels,
    goalsCollected: ledgers.length,
    skipped,
    notDue,
    failure: pass.failure ?? null,
    sweepSeconds: Math.round(seconds * 10) / 10,
    firstLedger,
    lastLedger,
    ledgersSpanned,
    txPerLedger:
      ledgersSpanned === 0
        ? 0
        : Math.round((ledgers.length / ledgersSpanned) * 1000) / 1000,
    peakTxPerLedger: Math.max(0, ...perLedger.values()),
    sentPerChannel,
    tryAgainLater,
    scanPages: pass.scan.pages,
    scanEvents: pass.scan.events,
  };
}

it(`sizes the keeper with ${String(GOALS)} goals and 1, 2 and 4 channels`, async () => {
  const runStarted = Date.now();
  // The guard in local-only.ts checked this already; check again here.
  expect((await server.getNetwork()).passphrase).toBe(PASSPHRASE);
  const ledgerAtStart = (await server.getLatestLedger()).sequence;

  // Accounts: a funder from Friendbot, then the owners and four channels.
  const funder = Keypair.random();
  const funded = await fetch(`${base}/friendbot?addr=${funder.publicKey()}`);
  expect(funded.ok).toBe(true);
  const ownerCount = Math.ceil(GOALS / PER_OWNER);
  const ownerKeys = Array.from({ length: ownerCount }, () => Keypair.random());
  const channelKeys = Array.from({ length: 4 }, () => Keypair.random());
  for (const batch of chunks(
    [
      ...ownerKeys.map((key) => [key, '20'] as const),
      ...channelKeys.map((key) => [key, '500'] as const),
    ],
    100,
  )) {
    await submit(
      funder,
      batch.map(([key, startingBalance]) =>
        Operation.createAccount({
          destination: key.publicKey(),
          startingBalance,
        }),
      ),
    );
  }
  // Each owner trusts TEST; then the issuer pays every owner.
  const [code, issuer] = ctx.asset.split(':') as [string, string];
  const asset = new Asset(code, issuer);
  await inPool(ownerKeys, OWNERS_AT_ONCE, (key) =>
    submit(key, [Operation.changeTrust({ asset })]),
  );
  const issuerKey = Keypair.fromSecret(
    await stellar(ctx.configDir, ['keys', 'secret', 'issuer']),
  );
  const amount = (Number(OWNER_TEST) / 1e7).toFixed(7);
  for (const batch of chunks(ownerKeys, 100)) {
    await submit(
      issuerKey,
      batch.map((key) =>
        Operation.payment({ destination: key.publicKey(), asset, amount }),
      ),
    );
  }

  // Goals: 20 per owner (the last owner may have fewer), 60 s cadence.
  const integrator = freshIntegrator();
  const setupStarted = Date.now();
  let created = 0;
  await inPool(ownerKeys, OWNERS_AT_ONCE, async (key, index) => {
    const count = Math.min(PER_OWNER, GOALS - index * PER_OWNER);
    const sdk = createLoktin({
      network: network(ctx),
      publicKey: key.publicKey(),
      signer: basicNodeSigner(key, PASSPHRASE),
    });
    const savings = new TargetSavings(sdk, {
      integrator,
      integratorFeeBps: 0,
    });
    const { latestLedger } = await sdk.ledgerInfo();
    for (let i = 0; i < count; i++) {
      // The token allowance is one per owner, and each approval replaces
      // the last, so only the last goal approves, for all of them.
      await savings.createGoal({
        target: toBaseUnits('1000'),
        deadline: new Date(Date.now() + 8 * 3600 * 1000),
        cadenceSeconds: MIN_CADENCE,
        depositSize: DEPOSIT,
        rule: { kind: 'lock' },
        allowance:
          i < count - 1
            ? 'none'
            : { amount: OWNER_TEST, expiryLedger: latestLedger + 50_000 },
      });
      created += 1;
    }
  });
  expect(created).toBe(GOALS);
  const setupSeconds = (Date.now() - setupStarted) / 1000;

  // The channels: each its own account, signer and counting server.
  const signers = channelKeys.map(counting);
  const channels: Loktin[] = channelKeys.map((key, index) =>
    createLoktin({
      network: network(ctx),
      server,
      publicKey: key.publicKey(),
      signer: {
        signTransaction: (signers[index] as ReturnType<typeof counting>)
          .signTransaction,
      },
    }),
  );

  // Every goal's first period has started once a cadence has passed since
  // the last goal was created.
  await sleep(MIN_CADENCE * 1000 + 5000);
  const sweeps: Sweep[] = [];
  for (const count of CHANNEL_COUNTS) {
    const before = signers.map((signer) => signer.signed());
    const againBefore = server.tryAgainLater;
    const started = Date.now();
    const pass = await runPass(channels.slice(0, count), {
      integrators: [integrator],
    });
    const seconds = (Date.now() - started) / 1000;
    const sweep = sweepOf(
      count,
      pass,
      seconds,
      signers
        .slice(0, count)
        .map((signer, i) => signer.signed() - (before[i] ?? 0)),
      server.tryAgainLater - againBefore,
    );
    sweeps.push(sweep);
    console.log(JSON.stringify({ sweep }));
    // A new period for every goal before the next sweep: the cadence again.
    await sleep(MIN_CADENCE * 1000 + 5000);
  }

  const ledgerAtEnd = (await server.getLatestLedger()).sequence;
  const runSeconds = (Date.now() - runStarted) / 1000;
  const secondsPerLedger =
    Math.round((runSeconds / (ledgerAtEnd - ledgerAtStart)) * 1000) / 1000;
  const results = {
    measuredAt: new Date(runStarted).toISOString(),
    network: {
      kind: 'private local network (stellar/quickstart, --limits testnet, protocol 29)',
      secondsPerLedger,
    },
    machine: {
      cpu: cpus()[0]?.model ?? 'unknown',
      cores: cpus().length,
      memoryGiB: Math.round(totalmem() / 2 ** 30),
      os: `${platform()} ${release()}`,
      node: process.version,
    },
    goals: GOALS,
    owners: ownerCount,
    goalsPerOwner: PER_OWNER,
    cadenceSeconds: MIN_CADENCE,
    depositSize: DEPOSIT.toString(),
    setupSeconds: Math.round(setupSeconds),
    runSeconds: Math.round(runSeconds),
    sweeps,
  };
  const table = [
    '| Channels | Collected | Sweep (s) | Ledgers | Collects per ledger | Peak per ledger | TRY_AGAIN_LATER | Failures |',
    '|---|---|---|---|---|---|---|---|',
    ...sweeps.map(
      (s) =>
        `| ${String(s.channels)} | ${String(s.goalsCollected)} | ${String(s.sweepSeconds)} | ${String(s.ledgersSpanned)} | ${String(s.txPerLedger)} | ${String(s.peakTxPerLedger)} | ${String(s.tryAgainLater)} | ${s.failure === null ? '0' : '1'} |`,
    ),
  ].join('\n');
  console.log(
    `${table}\n\nrun ${String(results.runSeconds)} s, ${String(secondsPerLedger)} s per ledger`,
  );
  if (GOALS === FULL_SIZE) {
    await writeFile(
      join(process.cwd(), 'docs', 'keeper-sizing.json'),
      `${JSON.stringify(results, null, 2)}\n`,
    );
  }
  for (const sweep of sweeps) {
    expect(sweep.failure).toBeNull();
    expect(sweep.goalsCollected).toBe(GOALS);
  }
});
