// One SDK instance per key (E3, W112): each key is a channel, with its own
// account and signer. No network call.
import { Keypair } from '@stellar/stellar-sdk/base';
import { basicNodeSigner } from '@stellar/stellar-sdk/contract';
import { type Loktin, TESTNET, createLoktin } from '@loktin/sdk';
import { feeCeilingSigner } from '@loktin/sdk/keeper';
import type { Settings } from './settings.ts';

/**
 * Builds one SDK instance per key, in the key file's order: testnet only
 * for now, with the settings' RPC URL, that key's public key, and its
 * signer wrapped in the fee ceiling. createLoktin checks the RPC URL.
 */
export function keepersOf(
  settings: Pick<Settings, 'secrets' | 'rpcUrl' | 'maxFeeStroops'>,
): Loktin[] {
  return settings.secrets.map((secret) => {
    const keypair = Keypair.fromSecret(secret);
    return createLoktin({
      network: TESTNET,
      rpcUrl: settings.rpcUrl,
      publicKey: keypair.publicKey(),
      signer: {
        signTransaction: feeCeilingSigner(
          basicNodeSigner(keypair, TESTNET.passphrase).signTransaction,
          settings.maxFeeStroops,
          TESTNET.passphrase,
        ),
      },
    });
  });
}
