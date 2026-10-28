// K6 (W81): every RPC request has a time limit. These tests use the real
// stellar-sdk Server, with a fetch that never answers, and real timers:
// Vitest's fake timers do not drive AbortSignal.timeout.
import type { SignTransaction } from '@stellar/stellar-sdk/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkError, createLoktin } from '../src/index.js';
import { USER } from './fake-server.js';

// The retries wait 0.5, 1 and 2 s, so each test takes about 3.5 s.
const TIMEOUT = 15_000;

let fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

beforeEach(() => {
  // Never answers; rejects only when the request's signal aborts.
  fetch = vi.fn<typeof globalThis.fetch>(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      }),
  );
  vi.stubGlobal('fetch', fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a request that runs out of time', () => {
  it(
    'makes a read fail with NETWORK after its retries',
    async () => {
      const loktin = createLoktin({ network: 'testnet', requestTimeoutMs: 50 });
      const error = await loktin
        .read('target-savings', 'min_cadence')
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NetworkError);
      expect(error).toMatchObject({ code: 'NETWORK' });
      expect((error as Error).message).toContain('timeout of 50 ms exceeded');
      // The first try and 3 retries.
      expect(fetch).toHaveBeenCalledTimes(4);
    },
    TIMEOUT,
  );

  it(
    'makes a write fail with NETWORK before signing',
    async () => {
      const signTransaction = vi.fn<SignTransaction>();
      const loktin = createLoktin({
        network: 'testnet',
        requestTimeoutMs: 50,
        publicKey: USER,
        signer: { signTransaction },
      });
      const error = await loktin
        .write('target-savings', 'collect', { goal_id: 1n })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NetworkError);
      expect((error as Error).message).toContain(
        "could not read the RPC's network: timeout of 50 ms exceeded",
      );
      // The network check: the first try and 3 retries.
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(signTransaction).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );
});
