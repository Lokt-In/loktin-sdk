// The private local network, its throwaway accounts and the Stellar CLI,
// shared by the end-to-end setup and tests.
import { execFile } from 'node:child_process';

export const PASSPHRASE = 'Standalone Network ; February 2017';
/** The Stellar CLI's name for the local network, in the temporary config. */
export const NETWORK = 'loktin-e2e';
/** The shortest cadence of the test instance, in seconds. */
export const MIN_CADENCE = 60;
export const LOKTIN_FEE_BPS = 100;

/** Every throwaway account, by its alias in the temporary CLI config. */
export const ACCOUNTS = [
  'deployer',
  'admin',
  'fee-admin',
  'pauser',
  'upgrader',
  'fee-recipient',
  'issuer',
  'user',
  // No trustline for the token, until the accrued-fees test adds one.
  'integrator',
  'payee',
  // Never gets a trustline.
  'payee2',
] as const;
export type Account = (typeof ACCOUNTS)[number];

/** What the global setup hands to the tests. It is never printed. */
export interface E2EContext {
  readonly configDir: string;
  readonly rpcUrl: string;
  /** `TEST:<issuer>`, the classic asset. */
  readonly asset: string;
  /** The asset's Stellar Asset Contract. */
  readonly token: string;
  readonly targetSavings: string;
  readonly spendSave: string;
  readonly addresses: Readonly<Record<Account, string>>;
  /** Throwaway secrets of the two accounts that sign through the SDK. */
  readonly secrets: { readonly user: string; readonly integrator: string };
}

/** Runs the Stellar CLI with the temporary config, never a shell. */
export function stellar(
  configDir: string,
  args: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'stellar',
      ['--config-dir', configDir, ...args],
      { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout.trim());
        } else {
          // Only the command name and stderr: arguments never hold a secret,
          // and stdout may.
          reject(
            new Error(
              `stellar ${args.slice(0, 2).join(' ')} failed: ${stderr.trim()}`,
            ),
          );
        }
      },
    );
  });
}
