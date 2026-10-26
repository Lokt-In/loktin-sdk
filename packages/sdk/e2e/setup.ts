// Global setup for the end-to-end tests: throwaway accounts, a test token
// and fresh instances of both contracts on the private local network that
// scripts/e2e.sh starts. Every key lives in a temporary CLI config outside
// the repo, which teardown deletes. Nothing secret is printed.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACCOUNTS,
  type Account,
  type E2EContext,
  LOKTIN_FEE_BPS,
  MIN_CADENCE,
  NETWORK,
  PASSPHRASE,
  stellar,
} from './local-network.js';

/** Minted to the user: 100,000 TEST, in base units. */
const USER_FUNDS = '1000000000000';
const READY_TIMEOUT_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Friendbot starts a few seconds after RPC reports healthy.
async function waitForFriendbot(friendbotUrl: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      const response = await fetch(friendbotUrl);
      // Without an address Friendbot answers 400 once it is up.
      if (response.status !== 502 && response.status !== 503) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`Friendbot at ${friendbotUrl} did not start`);
    }
    await sleep(2000);
  }
}

export default async function setup(project: {
  provide(key: 'e2e', value: E2EContext): void;
}): Promise<() => Promise<void>> {
  const port = process.env['E2E_PORT'] ?? '8000';
  const base = `http://localhost:${port}`;
  const rpcUrl = `${base}/rpc`;
  const configDir = await mkdtemp(join(tmpdir(), 'loktin-e2e-'));
  const teardown = () => rm(configDir, { recursive: true, force: true });
  try {
    const cli = (args: readonly string[]) => stellar(configDir, args);
    const onLocal = ['--network', NETWORK];

    await cli([
      'network',
      'add',
      NETWORK,
      '--rpc-url',
      rpcUrl,
      '--network-passphrase',
      PASSPHRASE,
    ]);
    await waitForFriendbot(`${base}/friendbot`);
    for (const name of ACCOUNTS) {
      await cli(['keys', 'generate', name, ...onLocal, '--fund']);
    }
    const addresses = Object.fromEntries(
      await Promise.all(
        ACCOUNTS.map(
          async (name) =>
            [name, await cli(['keys', 'public-key', name])] as const,
        ),
      ),
    ) as Record<Account, string>;

    const asset = `TEST:${addresses.issuer}`;
    const token = await cli([
      'contract',
      'asset',
      'deploy',
      '--asset',
      asset,
      '--source-account',
      'issuer',
      ...onLocal,
    ]);
    for (const holder of ['user', 'payee'] as const) {
      await cli([
        'tx',
        'new',
        'change-trust',
        '--line',
        asset,
        '--source-account',
        holder,
        ...onLocal,
      ]);
    }
    await cli([
      'tx',
      'new',
      'payment',
      '--destination',
      addresses.user,
      '--asset',
      asset,
      '--amount',
      USER_FUNDS,
      '--source-account',
      'issuer',
      ...onLocal,
    ]);

    // Fresh instances from the Wasm just built, charging a 1% Loktin fee.
    const wasm = (name: string) =>
      join(process.cwd(), 'target', 'wasm32v1-none', 'release', `${name}.wasm`);
    const roles = [
      '--admin',
      addresses.admin,
      '--fee_admin',
      addresses['fee-admin'],
      '--pauser',
      addresses.pauser,
      '--upgrader',
      addresses.upgrader,
      '--token',
      token,
      '--fee_recipient',
      addresses['fee-recipient'],
      '--loktin_fee_bps',
      String(LOKTIN_FEE_BPS),
    ];
    const deploy = (name: string, args: readonly string[]) =>
      cli([
        'contract',
        'deploy',
        '--wasm',
        wasm(name),
        '--source-account',
        'deployer',
        ...onLocal,
        '--',
        ...roles,
        ...args,
      ]);
    const targetSavings = await deploy('loktin_target_savings', [
      '--min_cadence',
      String(MIN_CADENCE),
    ]);
    // An Option<Address> is passed as a JSON string.
    const spendSave = await deploy('loktin_spend_save', [
      '--target_savings',
      `"${targetSavings}"`,
    ]);

    project.provide('e2e', {
      configDir,
      rpcUrl,
      asset,
      token,
      targetSavings,
      spendSave,
      addresses,
      secrets: {
        user: await cli(['keys', 'secret', 'user']),
        integrator: await cli(['keys', 'secret', 'integrator']),
      },
    });
  } catch (error) {
    await teardown();
    throw error;
  }
  return teardown;
}
