// The keeper's settings, from environment variables only (E9). Every value
// is checked before any network call. The secret is never printed.
import { StrKey } from '@stellar/stellar-sdk/base';

/** 1 XLM, in stroops (E10, W98). */
export const DEFAULT_MAX_FEE_STROOPS = 10_000_000n;
export const TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org';

export interface Settings {
  /** The keeper's secret key. Never logged. */
  readonly secret: string;
  readonly integrators: readonly string[] | 'all';
  readonly owners: readonly string[];
  readonly maxFeeStroops: bigint;
  readonly rpcUrl: string;
}

/** Bad settings, one message per problem. No message holds a secret. */
export class SettingsError extends Error {
  override readonly name = 'SettingsError';
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(problems.join('; '));
    this.problems = problems;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function isAddress(value: string): boolean {
  return StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value);
}

function addressList(
  name: string,
  value: string,
  problems: string[],
): string[] {
  const parts = value.split(',').map((part) => part.trim());
  if (parts.some((part) => part === '')) {
    problems.push(`${name} has an empty entry`);
    return [];
  }
  for (const part of parts) {
    if (!isAddress(part)) {
      problems.push(
        `${name}: ${part} is not an account (G...) or contract (C...) address`,
      );
    }
  }
  return parts;
}

/**
 * Reads the settings:
 * - `LOKTIN_KEEPER_SECRET_FILE`, a file holding the secret key (preferred),
 *   or `LOKTIN_KEEPER_SECRET`, the key itself (a weaker fallback, E4);
 * - `LOKTIN_KEEPER_INTEGRATORS`, a comma list of addresses, or `all`;
 * - `LOKTIN_KEEPER_OWNERS`, an optional comma list of owner addresses;
 * - `LOKTIN_KEEPER_MAX_FEE_STROOPS`, the fee ceiling, 10,000,000 (1 XLM) by default;
 * - `LOKTIN_RPC_URL`, testnet's by default.
 */
export async function loadSettings(
  env: Env,
  readFile: (path: string) => Promise<string>,
): Promise<Settings> {
  const problems: string[] = [];

  const file = env['LOKTIN_KEEPER_SECRET_FILE']?.trim() ?? '';
  const inline = env['LOKTIN_KEEPER_SECRET'] ?? '';
  let secret = '';
  if (file !== '' && inline !== '') {
    problems.push(
      'set only one of LOKTIN_KEEPER_SECRET_FILE and LOKTIN_KEEPER_SECRET',
    );
  } else if (file === '' && inline === '') {
    problems.push(
      'set LOKTIN_KEEPER_SECRET_FILE (or, as a weaker fallback, LOKTIN_KEEPER_SECRET)',
    );
  } else if (file !== '') {
    try {
      secret = (await readFile(file)).trim();
    } catch {
      problems.push(
        `could not read the file LOKTIN_KEEPER_SECRET_FILE names (${file})`,
      );
    }
  } else {
    secret = inline.trim();
  }
  if (secret !== '' && !StrKey.isValidEd25519SecretSeed(secret)) {
    problems.push('the keeper secret is not a Stellar secret key (S...)');
  } else if (secret === '' && problems.length === 0) {
    problems.push('the keeper secret is empty');
  }

  const integratorsValue = env['LOKTIN_KEEPER_INTEGRATORS']?.trim() ?? '';
  let integrators: string[] | 'all' = [];
  if (integratorsValue === '') {
    problems.push(
      'set LOKTIN_KEEPER_INTEGRATORS to a comma list of addresses, or all',
    );
  } else if (integratorsValue === 'all') {
    integrators = 'all';
  } else {
    integrators = addressList(
      'LOKTIN_KEEPER_INTEGRATORS',
      integratorsValue,
      problems,
    );
  }

  const ownersValue = env['LOKTIN_KEEPER_OWNERS']?.trim() ?? '';
  const owners =
    ownersValue === ''
      ? []
      : addressList('LOKTIN_KEEPER_OWNERS', ownersValue, problems);

  const feeValue = env['LOKTIN_KEEPER_MAX_FEE_STROOPS']?.trim() ?? '';
  let maxFeeStroops = DEFAULT_MAX_FEE_STROOPS;
  if (feeValue !== '') {
    if (/^[0-9]+$/.test(feeValue) && BigInt(feeValue) > 0n) {
      maxFeeStroops = BigInt(feeValue);
    } else {
      problems.push(
        'LOKTIN_KEEPER_MAX_FEE_STROOPS must be a whole number of stroops above zero',
      );
    }
  }

  const rpcUrl = env['LOKTIN_RPC_URL']?.trim() || TESTNET_RPC_URL;

  if (problems.length > 0) {
    throw new SettingsError(problems);
  }
  return { secret, integrators, owners, maxFeeStroops, rpcUrl };
}
