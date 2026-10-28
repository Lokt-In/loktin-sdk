// The smoke script's signer (W83): each transaction goes to the Stellar CLI,
// which signs it with a key from its own keystore. The script never reads
// the keystore and never handles a secret.
import type { SignTransaction } from '@stellar/stellar-sdk/contract';
import { execFile } from 'node:child_process';

/** A signer for one alias, which also counts the time spent signing. */
export interface TimedSigner {
  readonly signTransaction: SignTransaction;
  /** Milliseconds spent signing since the signer was made. */
  signingMs(): number;
}

/**
 * Signs with `stellar tx sign --quiet --sign-with-key <alias>`, called
 * directly (no shell), with the envelope on stdin.
 */
export function cliSigner(
  alias: string,
  address: string,
  passphrase: string,
): TimedSigner {
  let spent = 0;
  const signTransaction: SignTransaction = (xdr) => {
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const child = execFile(
        'stellar',
        [
          'tx',
          'sign',
          '--quiet',
          '--sign-with-key',
          alias,
          '--network-passphrase',
          passphrase,
        ],
        { maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          spent += performance.now() - started;
          const signed = stdout.trim();
          if (error !== null || signed === '') {
            // Nothing from the CLI is passed on: its output is not needed to
            // tell what failed, and a signer's output is never logged.
            reject(new Error(`stellar tx sign failed for ${alias}`));
            return;
          }
          resolve({ signedTxXdr: signed, signerAddress: address });
        },
      );
      child.stdin?.end(xdr);
    });
  };
  return { signTransaction, signingMs: () => spent };
}

/** The public address of an alias, from `stellar keys public-key`. */
export function publicKeyOf(alias: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('stellar', ['keys', 'public-key', alias], (error, stdout) => {
      const address = stdout.trim();
      if (error !== null || address === '') {
        reject(new Error(`no Stellar CLI identity named ${alias}`));
        return;
      }
      resolve(address);
    });
  });
}
