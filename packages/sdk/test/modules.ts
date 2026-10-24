import type { SignTransaction } from '@stellar/stellar-sdk/contract';
import type { ScVal } from '@stellar/stellar-sdk/xdr';
import { vi } from 'vitest';
import type { ReadAdapter } from '../src/config.js';
import { type Loktin, createLoktin } from '../src/index.js';
import { type LoktinContract, specs } from '../src/specs.js';
import {
  type FakeServer,
  USER,
  sendResponse,
  simulationSuccess,
  success,
} from './fake-server.js';

// A wallet that returns the transaction unchanged. No key is involved.
export function passThroughSigner(): ReturnType<typeof vi.fn<SignTransaction>> {
  return vi.fn<SignTransaction>((xdr) =>
    Promise.resolve({ signedTxXdr: xdr, signerAddress: USER }),
  );
}

/** An SDK instance for `USER` on the fake server. */
export function loktinOn(
  server: FakeServer,
  readAdapter?: ReadAdapter,
): Loktin {
  return createLoktin({
    network: 'testnet',
    server,
    publicKey: USER,
    signer: { signTransaction: passThroughSigner() },
    ...(readAdapter === undefined ? {} : { readAdapter }),
  });
}

/** Encodes what a contract function returns, as the chain would. */
export function retvalOf(
  contract: LoktinContract,
  method: string,
  native: unknown,
): ScVal {
  const spec = specs[contract];
  const [output] = spec.getFunc(method).outputs;
  if (output === undefined) {
    throw new Error(`${method} returns nothing`);
  }
  const type =
    output.type === 'scSpecTypeResult' ? output.result.okType : output;
  return spec.nativeToScVal(native, type);
}

/** Queues the answers of one successful write that returns `retval`. */
export function queueWrite(server: FakeServer, retval: ScVal): void {
  server.simulations.push(simulationSuccess(retval));
  server.sends.push(sendResponse('PENDING'));
  server.polls.push(success(retval));
}

/** Runs a call to its end under fake timers, and returns its result or error. */
export async function settle(promise: Promise<unknown>): Promise<unknown> {
  const outcome = promise.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(120_000);
  return outcome;
}

/** The XDR of each value, to compare encoded arguments. */
export function xdrOf(values: readonly ScVal[]): string[] {
  return values.map((value) => value.toXdr('base64'));
}
