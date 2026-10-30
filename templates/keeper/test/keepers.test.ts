import { Keypair } from '@stellar/stellar-sdk/base';
import { TESTNET } from '@loktin/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepersOf } from '../src/keepers.ts';
import { TESTNET_RPC_URL } from '../src/settings.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the keeper instances', () => {
  it('are one per key, in order, on testnet, with no network call', () => {
    // Throwaway keys made in memory; they are never printed.
    const keys = [Keypair.random(), Keypair.random()];
    const fetch = vi.spyOn(globalThis, 'fetch');
    const keepers = keepersOf({
      secrets: keys.map((key) => key.secret()),
      rpcUrl: TESTNET_RPC_URL,
      maxFeeStroops: 10_000_000n,
    });
    expect(keepers.map((keeper) => keeper.config.publicKey)).toEqual(
      keys.map((key) => key.publicKey()),
    );
    for (const keeper of keepers) {
      expect(keeper.config.passphrase).toBe(TESTNET.passphrase);
      expect(keeper.config.rpcUrl).toBe(TESTNET_RPC_URL);
      expect(keeper.config.signer).toBeDefined();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
