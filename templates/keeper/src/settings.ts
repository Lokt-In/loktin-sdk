// The keeper's settings, from environment variables only (E9). Every value
// is checked before any network call. The secret is never printed.
import { Keypair, StrKey } from '@stellar/stellar-sdk/base';

/** 1 XLM, in stroops (E10, W98). */
export const DEFAULT_MAX_FEE_STROOPS = 10_000_000n;
export const TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org';

export interface Settings {
  /**
   * The keeper's secret keys, in file order: one per channel (E3, W112).
   * Never logged.
   */
  readonly secrets: readonly string[];
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
 * The keys of a key file: one per line, each line trimmed (so CRLF files
 * work), blank lines ignored. Problems name lines by number, never a key.
 */
function keysOf(text: string, problems: string[]): string[] {
  const keys: string[] = [];
  const lineOf = new Map<string, number>();
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (line === '') {
      return;
    }
    const number = index + 1;
    if (!StrKey.isValidEd25519SecretSeed(line)) {
      problems.push(
        `line ${String(number)} of the key file is not a Stellar secret key (S...)`,
      );
      return;
    }
    const publicKey = Keypair.fromSecret(line).publicKey();
    const first = lineOf.get(publicKey);
    if (first !== undefined) {
      problems.push(
        `the key file has the same key on lines ${String(first)} and ${String(number)}`,
      );
      return;
    }
    lineOf.set(publicKey, number);
    keys.push(line);
  });
  if (keys.length === 0 && problems.length === 0) {
    problems.push('the key file holds no key');
  }
  return keys;
}

/**
 * Reads the settings:
 * - `LOKTIN_KEEPER_SECRET_FILE`, a file holding the keeper's secret key, or
 *   several keys, one per line, each a channel (preferred, E3, W112); or
 *   `LOKTIN_KEEPER_SECRET`, one key itself (a weaker fallback, E4);
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
  let secrets: string[] = [];
  if (file !== '' && inline !== '') {
    problems.push(
      'set only one of LOKTIN_KEEPER_SECRET_FILE and LOKTIN_KEEPER_SECRET',
    );
  } else if (file === '' && inline === '') {
    problems.push(
      'set LOKTIN_KEEPER_SECRET_FILE (or, as a weaker fallback, LOKTIN_KEEPER_SECRET)',
    );
  } else if (file !== '') {
    let text: string | undefined;
    try {
      text = await readFile(file);
    } catch {
      problems.push(
        `could not read the file LOKTIN_KEEPER_SECRET_FILE names (${file})`,
      );
    }
    if (text !== undefined) {
      secrets = keysOf(text, problems);
    }
  } else {
    const secret = inline.trim();
    if (secret === '') {
      problems.push('the keeper secret is empty');
    } else if (!StrKey.isValidEd25519SecretSeed(secret)) {
      problems.push('the keeper secret is not a Stellar secret key (S...)');
    } else {
      secrets = [secret];
    }
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
  return { secrets, integrators, owners, maxFeeStroops, rpcUrl };
}
