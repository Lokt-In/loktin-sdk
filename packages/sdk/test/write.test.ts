import { StrKey, TransactionBuilder } from '@stellar/stellar-sdk/base';
import type { SignTransaction } from '@stellar/stellar-sdk/contract';
import { ScVal } from '@stellar/stellar-sdk/xdr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InvalidInputError,
  NetworkError,
  PendingError,
  SignerRefusedError,
  TESTNET,
  TokenError,
  TransactionFailedError,
  UnknownContractError,
  createLoktin,
} from '../src/index.js';
import {
  FakeServer,
  TESTNET_PASSPHRASE,
  USER,
  authEntryFor,
  errorEvent,
  failed,
  notFound,
  sendResponse,
  simulationFailure,
  simulationSuccess,
  success,
} from './fake-server.js';

const DEPOSIT = { owner: USER, goal_id: 3n, amount: 50_000_000n };

let server: FakeServer;
let signTransaction: ReturnType<typeof vi.fn<SignTransaction>>;

// A wallet that returns the transaction unchanged. No key is involved.
function passThroughSigner(): ReturnType<typeof vi.fn<SignTransaction>> {
  return vi.fn<SignTransaction>((xdr) =>
    Promise.resolve({ signedTxXdr: xdr, signerAddress: USER }),
  );
}

function loktin() {
  return createLoktin({
    network: 'testnet',
    server,
    publicKey: USER,
    signer: { signTransaction },
  });
}

// Runs a write to its end under fake timers, and returns its result or error.
async function settle(
  promise: Promise<unknown>,
  ms = 120_000,
): Promise<unknown> {
  const outcome = promise.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(ms);
  return outcome;
}

beforeEach(() => {
  vi.useFakeTimers();
  server = new FakeServer();
  signTransaction = passThroughSigner();
  server.simulations.push(simulationSuccess(ScVal.scvVoid()));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('writes', () => {
  it('call getNetwork, getAccount, simulate, send and getTransaction, in that order', async () => {
    server.sends.push(sendResponse('PENDING'));
    server.polls.push(success(ScVal.scvVoid()));
    const result = await settle(
      loktin().write('target-savings', 'deposit', DEPOSIT),
    );

    expect(result).toEqual({
      hash: 'ab'.repeat(32),
      ledger: 101,
      result: null,
    });
    expect(server.methods()).toEqual([
      'getNetwork',
      'getAccount',
      'simulateTransaction',
      'sendTransaction',
      'getTransaction',
    ]);
    expect(signTransaction).toHaveBeenCalledOnce();
    expect(signTransaction.mock.calls[0]?.[1]).toMatchObject({
      networkPassphrase: TESTNET_PASSPHRASE,
    });
  });

  it('call getNetwork once per instance', async () => {
    server.sends.push(sendResponse('PENDING'));
    server.polls.push(success(ScVal.scvVoid()));
    const instance = loktin();
    await settle(instance.write('target-savings', 'deposit', DEPOSIT));
    await settle(instance.write('target-savings', 'deposit', DEPOSIT));
    expect(
      server.methods().filter((method) => method === 'getNetwork'),
    ).toHaveLength(1);

    await settle(loktin().write('target-savings', 'deposit', DEPOSIT));
    expect(
      server.methods().filter((method) => method === 'getNetwork'),
    ).toHaveLength(2);
  });

  it('decode the return value with the spec, without the Result wrapper', async () => {
    server.sends.push(sendResponse('PENDING'));
    server.polls.push(notFound(), notFound(), success(ScVal.scvU64(9n)));
    const result = await settle(
      loktin().write('target-savings', 'collect', { goal_id: 9n }),
    );
    expect(result).toMatchObject({ result: 9n });
    expect(
      server.methods().filter((method) => method === 'getTransaction'),
    ).toHaveLength(3);
  });

  it('stop before signing when the RPC serves another network', async () => {
    server.passphrase = 'Public Global Stellar Network ; September 2015';
    const instance = loktin();
    // Awaited without moving the fake clock: a retry would wait forever.
    const error = await instance
      .write('target-savings', 'deposit', DEPOSIT)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as Error).message).toContain('not the configured');
    expect(signTransaction).not.toHaveBeenCalled();
    expect(server.methods()).toEqual(['getNetwork']);

    // The instance keeps refusing at once, without asking again.
    await expect(
      instance.write('target-savings', 'deposit', DEPOSIT),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(server.methods()).toEqual(['getNetwork']);
  });

  it('say both causes when the account cannot be loaded, after 3 retries', async () => {
    // stellar-sdk reports every lookup failure this way.
    server.accountError = new Error(`Account not found: ${USER}`);
    const error = await settle(
      loktin().write('target-savings', 'deposit', DEPOSIT),
    );
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as Error).message).toBe(
      `could not load account ${USER}: it may not exist on this network yet (an account is created by sending it XLM), or the RPC could not be reached`,
    );
    expect(signTransaction).not.toHaveBeenCalled();
    expect(server.methods()).toEqual([
      'getNetwork',
      'getAccount',
      'getAccount',
      'getAccount',
      'getAccount',
    ]);
  });

  it('need publicKey and signer, checked before any network call', async () => {
    const readOnly = createLoktin({ network: 'testnet', server });
    await expect(
      readOnly.write('target-savings', 'deposit', DEPOSIT),
    ).rejects.toThrow(InvalidInputError);
    await expect(
      loktin().write('target-savings', 'deposit', { owner: USER }),
    ).rejects.toThrow(InvalidInputError);
    expect(server.calls).toEqual([]);
  });

  it('resend the identical envelope on TRY_AGAIN_LATER, after 1 s, 2 s and 4 s', async () => {
    server.sends.push(
      sendResponse('TRY_AGAIN_LATER'),
      sendResponse('TRY_AGAIN_LATER'),
      sendResponse('PENDING'),
    );
    server.polls.push(success(ScVal.scvVoid()));
    const promise = loktin().write('target-savings', 'deposit', DEPOSIT);
    const sends = () =>
      server.calls.filter((call) => call.method === 'sendTransaction');

    await vi.advanceTimersByTimeAsync(0);
    expect(sends()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(sends()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sends()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sends()).toHaveLength(3);
    await expect(settle(promise)).resolves.toMatchObject({ ledger: 101 });

    const envelopes = new Set(sends().map((call) => call.envelope));
    expect(envelopes.size).toBe(1);
    expect(signTransaction).toHaveBeenCalledOnce();
    expect(
      server.methods().filter((method) => method === 'simulateTransaction'),
    ).toHaveLength(1);
  });

  it('resend at most 3 times', async () => {
    server.sends.push(sendResponse('TRY_AGAIN_LATER'));
    const error = await settle(
      loktin().write('target-savings', 'deposit', DEPOSIT),
    );
    expect(error).toBeInstanceOf(NetworkError);
    expect(
      server.methods().filter((method) => method === 'sendTransaction'),
    ).toHaveLength(4);
    expect(server.methods()).not.toContain('getTransaction');
  });

  it('poll on DUPLICATE', async () => {
    server.sends.push(sendResponse('DUPLICATE'));
    server.polls.push(notFound(), success(ScVal.scvVoid()));
    await expect(
      settle(loktin().write('target-savings', 'deposit', DEPOSIT)),
    ).resolves.toMatchObject({ ledger: 101 });
    expect(
      server.methods().filter((method) => method === 'sendTransaction'),
    ).toHaveLength(1);
    expect(
      server.methods().filter((method) => method === 'getTransaction'),
    ).toHaveLength(2);
  });

  it('throw PENDING after 60 s, with no second send and no new build', async () => {
    server.sends.push(sendResponse('PENDING'));
    server.polls.push(notFound());
    const start = Date.now();
    const promise = loktin().write('target-savings', 'deposit', DEPOSIT);
    const outcome = promise.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(server.methods().at(-1)).toBe('getTransaction');
    await vi.advanceTimersByTimeAsync(2000);
    const error = await outcome;

    expect(error).toBeInstanceOf(PendingError);
    expect(error).toMatchObject({ code: 'PENDING', hash: 'ab'.repeat(32) });
    const validUntil = (error as PendingError).validUntil;
    expect(validUntil).toBeInstanceOf(Date);
    // The client's default timeout is 300 s from signing.
    expect(validUntil?.getTime()).toBeGreaterThan(start);

    const methods = server.methods();
    expect(
      methods.filter((method) => method === 'sendTransaction'),
    ).toHaveLength(1);
    expect(
      methods.filter((method) => method === 'simulateTransaction'),
    ).toHaveLength(1);
    expect(methods.filter((method) => method === 'getAccount')).toHaveLength(1);
    expect(signTransaction).toHaveBeenCalledOnce();

    // Nothing more happens afterwards.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(server.methods()).toEqual(methods);
  });

  it('keep polling through failed polls until the deadline', async () => {
    server.sends.push(sendResponse('PENDING'));
    server.polls.push(
      new Error('fetch failed'),
      new Error('fetch failed'),
      success(ScVal.scvVoid()),
    );
    await expect(
      settle(loktin().write('target-savings', 'deposit', DEPOSIT)),
    ).resolves.toMatchObject({ ledger: 101 });
  });

  it('throw PENDING with the local hash when the send itself fails', async () => {
    server.sends.push(new Error('socket hang up'));
    const error = await settle(
      loktin().write('target-savings', 'deposit', DEPOSIT),
    );
    expect(error).toBeInstanceOf(PendingError);
    const envelope =
      server.calls.find((call) => call.method === 'sendTransaction')
        ?.envelope ?? '';
    const sent = TransactionBuilder.fromXdr(envelope, TESTNET_PASSPHRASE);
    const hash = Array.from(sent.hash(), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    expect(error).toMatchObject({ hash });
  });

  it('map an ERROR send status to TRANSACTION_FAILED', async () => {
    server.sends.push(sendResponse('ERROR'));
    const error = await settle(
      loktin().write('target-savings', 'deposit', DEPOSIT),
    );
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error).toMatchObject({
      code: 'TRANSACTION_FAILED',
      hash: 'ab'.repeat(32),
    });
    expect(server.methods()).not.toContain('getTransaction');
  });

  it('map a FAILED transaction to TRANSACTION_FAILED, with the origin from its events', async () => {
    server.sends.push(sendResponse('PENDING'));
    server.polls.push(failed('txFailed', [errorEvent(TESTNET.token, 10)]));
    const error = await settle(
      loktin().write('target-savings', 'deposit', DEPOSIT),
    );
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error).toMatchObject({
      hash: 'ab'.repeat(32),
      resultCode: 'txFailed',
    });
    expect((error as TransactionFailedError).origin).toBeInstanceOf(TokenError);
    expect((error as TransactionFailedError).origin).toMatchObject({
      errorName: 'Balance',
    });
  });

  it('map a failed simulation by origin, before signing', async () => {
    server.simulations.length = 0;
    server.simulations.push(
      simulationFailure('HostError', [errorEvent(TESTNET.token, 9)]),
    );
    const error = await settle(
      loktin().write('target-savings', 'deposit', DEPOSIT),
    );
    expect(error).toMatchObject({
      code: 'TOKEN_ERROR',
      errorName: 'Allowance',
    });
    expect(signTransaction).not.toHaveBeenCalled();
    expect(server.methods()).not.toContain('sendTransaction');
  });

  it('refuse a simulation that reports a restore preamble', async () => {
    server.simulations.length = 0;
    server.simulations.push(
      simulationSuccess(ScVal.scvVoid(), { restore: true }),
    );
    const error = await settle(
      loktin().write('target-savings', 'deposit', DEPOSIT),
    );
    expect(error).toBeInstanceOf(UnknownContractError);
    expect((error as Error).message).toContain('restore');
    expect(signTransaction).not.toHaveBeenCalled();
    expect(server.methods()).not.toContain('sendTransaction');
  });
});

describe('signers', () => {
  it('map wallet error -4 to SIGNER_REFUSED', async () => {
    signTransaction = vi.fn<SignTransaction>(() =>
      Promise.resolve({
        signedTxXdr: '',
        error: { code: -4, message: 'User declined' },
      }),
    );
    const error = await settle(
      loktin().write('target-savings', 'deposit', DEPOSIT),
    );
    expect(error).toBeInstanceOf(SignerRefusedError);
    expect(error).toMatchObject({
      code: 'SIGNER_REFUSED',
      walletCode: -4,
      walletMessage: 'User declined',
    });
    expect(server.methods()).not.toContain('sendTransaction');
  });

  it('map a wallet that throws to SIGNER_REFUSED', async () => {
    signTransaction = vi.fn<SignTransaction>(() =>
      Promise.reject(new Error('wallet closed')),
    );
    const error = await settle(
      loktin().write('target-savings', 'deposit', DEPOSIT),
    );
    expect(error).toMatchObject({
      code: 'SIGNER_REFUSED',
      walletCode: undefined,
      walletMessage: 'wallet closed',
    });
  });

  it('refuse a call that needs another address to sign, as INVALID_INPUT', async () => {
    const other = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(8));
    server.simulations.length = 0;
    server.simulations.push(
      simulationSuccess(ScVal.scvVoid(), {
        auth: [authEntryFor(other, TESTNET.contracts.targetSavings)],
      }),
    );
    const error = await settle(
      loktin().write('target-savings', 'deposit', DEPOSIT),
    );
    expect(error).toBeInstanceOf(InvalidInputError);
    expect((error as Error).message).toContain(
      'publicKey must be the address the call acts for',
    );
    expect((error as Error).message).toContain(other);
    expect(signTransaction).not.toHaveBeenCalled();
    expect(server.methods()).not.toContain('sendTransaction');
  });
});

describe('retries before signing (K6, W77)', () => {
  const count = (method: string) =>
    server.methods().filter((called) => called === method).length;

  function queueSuccess(): void {
    server.sends.push(sendResponse('PENDING'));
    server.polls.push(success(ScVal.scvVoid()));
  }

  it('retry an account lookup that fails twice, and sign once', async () => {
    server.accountErrors.push(
      new Error(`Account not found: ${USER}`),
      new Error(`Account not found: ${USER}`),
    );
    queueSuccess();
    const result = await settle(
      loktin().write('target-savings', 'deposit', DEPOSIT),
    );
    expect(result).toMatchObject({ result: null });
    expect(count('getAccount')).toBe(3);
    expect(signTransaction).toHaveBeenCalledOnce();
  });

  it('retry a network check that fails once', async () => {
    server.networkErrors.push(new Error('fetch failed'));
    queueSuccess();
    const result = await settle(
      loktin().write('target-savings', 'deposit', DEPOSIT),
    );
    expect(result).toMatchObject({ result: null });
    expect(count('getNetwork')).toBe(2);
    expect(signTransaction).toHaveBeenCalledOnce();
  });

  it('retry a simulation that fails once with a network error', async () => {
    server.simulations.length = 0;
    server.simulations.push(
      new Error('fetch failed'),
      simulationSuccess(ScVal.scvVoid()),
    );
    queueSuccess();
    const result = await settle(
      loktin().write('target-savings', 'deposit', DEPOSIT),
    );
    expect(result).toMatchObject({ result: null });
    expect(count('simulateTransaction')).toBe(2);
    expect(signTransaction).toHaveBeenCalledOnce();
  });

  it('never retry a contract error from simulation', async () => {
    server.simulations.length = 0;
    server.simulations.push(
      simulationFailure('HostError', [
        errorEvent(TESTNET.contracts.targetSavings, 100),
      ]),
    );
    const error = await settle(
      loktin().write('target-savings', 'deposit', DEPOSIT),
    );
    expect(error).toMatchObject({
      code: 'CONTRACT_ERROR',
      errorName: 'GoalNotFound',
    });
    expect(count('simulateTransaction')).toBe(1);
    expect(signTransaction).not.toHaveBeenCalled();
  });
});
