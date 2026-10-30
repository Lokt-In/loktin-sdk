import { Keypair, StrKey } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_FEE_STROOPS,
  SettingsError,
  TESTNET_RPC_URL,
  loadSettings,
} from '../src/settings.ts';

// Throwaway keys made in memory for the tests; they are never printed.
const SECRET = Keypair.random().secret();
const SECRET_2 = Keypair.random().secret();
const SECRET_3 = Keypair.random().secret();
const ALL_SECRETS = [SECRET, SECRET_2, SECRET_3];
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
      // No message ever holds a key.
      for (const secret of ALL_SECRETS) {
        expect(error.problems.join(' ')).not.toContain(secret);
      }
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
      secrets: [SECRET],
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
      secrets: [SECRET],
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
    ).toEqual(['the key file holds no key']);
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

  describe('with several keys in the file', () => {
    const fromFile = (text: string) =>
      loadSettings(
        {
          LOKTIN_KEEPER_SECRET_FILE: '/run/secrets/keeper',
          LOKTIN_KEEPER_INTEGRATORS: INTEGRATOR,
        },
        () => Promise.resolve(text),
      );
    const fileProblems = (text: string) =>
      problemsOf(
        {
          LOKTIN_KEEPER_SECRET_FILE: '/run/secrets/keeper',
          LOKTIN_KEEPER_INTEGRATORS: INTEGRATOR,
        },
        () => Promise.resolve(text),
      );

    it('read one key exactly as before', async () => {
      expect((await fromFile(`${SECRET}\n`)).secrets).toEqual([SECRET]);
      expect((await fromFile(SECRET)).secrets).toEqual([SECRET]);
    });

    it('give three keys back in file order', async () => {
      expect(
        (await fromFile(`${SECRET_2}\n${SECRET}\n${SECRET_3}\n`)).secrets,
      ).toEqual([SECRET_2, SECRET, SECRET_3]);
    });

    it('accept blank lines, a trailing newline and CRLF', async () => {
      expect(
        (await fromFile(`\r\n${SECRET}\r\n\r\n  ${SECRET_2}  \r\n\n`)).secrets,
      ).toEqual([SECRET, SECRET_2]);
    });

    it('name a bad line by its number', async () => {
      expect(await fileProblems(`${SECRET}\nnot-a-key\n${SECRET_2}\n`)).toEqual(
        ['line 2 of the key file is not a Stellar secret key (S...)'],
      );
      // A public key is not a secret key either.
      expect(await fileProblems(`${SECRET}\n${INTEGRATOR}\n`)).toEqual([
        'line 2 of the key file is not a Stellar secret key (S...)',
      ]);
    });

    it('refuse the same key twice', async () => {
      expect(
        await fileProblems(`${SECRET}\n${SECRET_2}\n\n${SECRET}\n`),
      ).toEqual(['the key file has the same key on lines 1 and 4']);
    });

    it('refuse a file of blank lines', async () => {
      expect(await fileProblems('\n  \n\r\n')).toEqual([
        'the key file holds no key',
      ]);
    });

    it('take one key only from the inline variable', async () => {
      expect(
        await problemsOf({
          LOKTIN_KEEPER_SECRET: `${SECRET}\n${SECRET_2}`,
          LOKTIN_KEEPER_INTEGRATORS: INTEGRATOR,
        }),
      ).toEqual(['the keeper secret is not a Stellar secret key (S...)']);
    });
  });
});
