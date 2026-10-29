import { Keypair, StrKey } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_FEE_STROOPS,
  SettingsError,
  TESTNET_RPC_URL,
  loadSettings,
} from '../src/settings.ts';

// A throwaway key made in memory for the tests; it is never printed.
const SECRET = Keypair.random().secret();
const INTEGRATOR = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(1));
const OWNER = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(2));

const noFile = () => Promise.reject(new Error('no file'));

async function problemsOf(
  env: Record<string, string>,
  readFile: (path: string) => Promise<string> = noFile,
): Promise<readonly string[]> {
  try {
    await loadSettings(env, readFile);
  } catch (error) {
    if (error instanceof SettingsError) {
      // No message ever holds the secret.
      expect(error.problems.join(' ')).not.toContain(SECRET);
      return error.problems;
    }
    throw error;
  }
  return [];
}

describe('the keeper settings', () => {
  it('read the secret file, trimming whitespace, with the defaults', async () => {
    const settings = await loadSettings(
      {
        LOKTIN_KEEPER_SECRET_FILE: '/run/secrets/keeper',
        LOKTIN_KEEPER_INTEGRATORS: ` ${INTEGRATOR} `,
      },
      (path) =>
        path === '/run/secrets/keeper'
          ? Promise.resolve(`\n  ${SECRET}\n`)
          : noFile(),
    );
    expect(settings).toEqual({
      secret: SECRET,
      integrators: [INTEGRATOR],
      owners: [],
      maxFeeStroops: DEFAULT_MAX_FEE_STROOPS,
      rpcUrl: TESTNET_RPC_URL,
    });
    expect(DEFAULT_MAX_FEE_STROOPS).toBe(10_000_000n);
  });

  it('take the secret from the weaker fallback, all integrators, owners, a fee and an RPC URL', async () => {
    expect(
      await loadSettings(
        {
          LOKTIN_KEEPER_SECRET: SECRET,
          LOKTIN_KEEPER_INTEGRATORS: 'all',
          LOKTIN_KEEPER_OWNERS: `${OWNER}, ${INTEGRATOR}`,
          LOKTIN_KEEPER_MAX_FEE_STROOPS: '2500000',
          LOKTIN_RPC_URL: 'http://localhost:8000/rpc',
        },
        noFile,
      ),
    ).toEqual({
      secret: SECRET,
      integrators: 'all',
      owners: [OWNER, INTEGRATOR],
      maxFeeStroops: 2_500_000n,
      rpcUrl: 'http://localhost:8000/rpc',
    });
  });

  it('refuse missing integrators', async () => {
    expect(await problemsOf({ LOKTIN_KEEPER_SECRET: SECRET })).toEqual([
      'set LOKTIN_KEEPER_INTEGRATORS to a comma list of addresses, or all',
    ]);
    expect(
      await problemsOf({
        LOKTIN_KEEPER_SECRET: SECRET,
        LOKTIN_KEEPER_INTEGRATORS: `${INTEGRATOR},,`,
      }),
    ).toEqual(['LOKTIN_KEEPER_INTEGRATORS has an empty entry']);
    expect(
      await problemsOf({
        LOKTIN_KEEPER_SECRET: SECRET,
        LOKTIN_KEEPER_INTEGRATORS: 'GABC',
      }),
    ).toEqual([
      'LOKTIN_KEEPER_INTEGRATORS: GABC is not an account (G...) or contract (C...) address',
    ]);
  });

  it('refuse both or neither secret source, an unreadable file and a bad key', async () => {
    const integrators = { LOKTIN_KEEPER_INTEGRATORS: INTEGRATOR };
    expect(
      await problemsOf({
        ...integrators,
        LOKTIN_KEEPER_SECRET: SECRET,
        LOKTIN_KEEPER_SECRET_FILE: '/run/secrets/keeper',
      }),
    ).toEqual([
      'set only one of LOKTIN_KEEPER_SECRET_FILE and LOKTIN_KEEPER_SECRET',
    ]);
    expect(await problemsOf(integrators)).toEqual([
      'set LOKTIN_KEEPER_SECRET_FILE (or, as a weaker fallback, LOKTIN_KEEPER_SECRET)',
    ]);
    expect(
      await problemsOf({
        ...integrators,
        LOKTIN_KEEPER_SECRET_FILE: '/run/secrets/missing',
      }),
    ).toEqual([
      'could not read the file LOKTIN_KEEPER_SECRET_FILE names (/run/secrets/missing)',
    ]);
    expect(
      await problemsOf(
        { ...integrators, LOKTIN_KEEPER_SECRET_FILE: '/run/secrets/keeper' },
        () => Promise.resolve('  \n'),
      ),
    ).toEqual(['the keeper secret is empty']);
    expect(
      await problemsOf({
        ...integrators,
        LOKTIN_KEEPER_SECRET: INTEGRATOR,
      }),
    ).toEqual(['the keeper secret is not a Stellar secret key (S...)']);
  });

  it('refuse a bad fee ceiling', async () => {
    for (const fee of ['0', '-1', '1.5', 'one', '1e7']) {
      expect(
        await problemsOf({
          LOKTIN_KEEPER_SECRET: SECRET,
          LOKTIN_KEEPER_INTEGRATORS: INTEGRATOR,
          LOKTIN_KEEPER_MAX_FEE_STROOPS: fee,
        }),
      ).toEqual([
        'LOKTIN_KEEPER_MAX_FEE_STROOPS must be a whole number of stroops above zero',
      ]);
    }
  });

  it('report every problem at once', async () => {
    expect(
      await problemsOf({
        LOKTIN_KEEPER_OWNERS: 'nobody',
        LOKTIN_KEEPER_MAX_FEE_STROOPS: '0',
      }),
    ).toHaveLength(4);
  });
});
