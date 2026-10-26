// Test helpers: the context the global setup provides, and SDK instances
// that sign with throwaway keys.
import { Keypair } from '@stellar/stellar-sdk/base';
import { basicNodeSigner } from '@stellar/stellar-sdk/contract';
import { inject } from 'vitest';
import { type Loktin, type NetworkSettings, createLoktin } from '@loktin/sdk';
import { type E2EContext, PASSPHRASE } from './local-network.js';

export * from './local-network.js';

declare module 'vitest' {
  interface ProvidedContext {
    e2e: E2EContext;
  }
}

export function context(): E2EContext {
  return inject('e2e');
}

export function network(ctx: E2EContext): NetworkSettings {
  return {
    passphrase: PASSPHRASE,
    rpcUrl: ctx.rpcUrl,
    contracts: { targetSavings: ctx.targetSavings, spendSave: ctx.spendSave },
    token: ctx.token,
  };
}

/** An SDK instance that signs as one of the throwaway accounts. */
export function sdkFor(
  ctx: E2EContext,
  who: keyof E2EContext['secrets'],
): Loktin {
  const keypair = Keypair.fromSecret(ctx.secrets[who]);
  return createLoktin({
    network: network(ctx),
    publicKey: keypair.publicKey(),
    signer: basicNodeSigner(keypair, PASSPHRASE),
  });
}

/** A fresh integrator address. It needs no account: fees only accrue to it. */
export function freshIntegrator(): string {
  return Keypair.random().publicKey();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The UTC day of the month, which decides whether a withdrawal window can open. */
export function utcDay(): number {
  return new Date().getUTCDate();
}
