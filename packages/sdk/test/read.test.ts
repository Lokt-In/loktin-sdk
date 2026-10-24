import { ScVal } from '@stellar/stellar-sdk/xdr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContractError,
  InvalidInputError,
  NetworkError,
  TESTNET,
  createLoktin,
} from '../src/index.js';
import {
  FakeServer,
  USER,
  errorEvent,
  simulationFailure,
  simulationSuccess,
} from './fake-server.js';

let server: FakeServer;

beforeEach(() => {
  server = new FakeServer();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reads', () => {
  it('make exactly one server call, and decode the result', async () => {
    server.simulations.push(simulationSuccess(ScVal.scvU64(42n)));
    const loktin = createLoktin({ network: 'testnet', server });
    await expect(loktin.read('target-savings', 'next_id')).resolves.toBe(42n);
    expect(server.methods()).toEqual(['simulateTransaction']);
  });

  it('make no account lookup, even with a publicKey configured', async () => {
    server.simulations.push(simulationSuccess(ScVal.scvBool(false)));
    const loktin = createLoktin({
      network: 'testnet',
      server,
      publicKey: USER,
    });
    await expect(loktin.read('spend-save', 'paused')).resolves.toBe(false);
    expect(server.methods()).toEqual(['simulateTransaction']);
  });

  it('check the function and arguments before any network call', async () => {
    const loktin = createLoktin({ network: 'testnet', server });
    await expect(
      loktin.read('target-savings', 'no_such_function'),
    ).rejects.toThrow(InvalidInputError);
    await expect(
      loktin.read('target-savings', '__constructor'),
    ).rejects.toThrow(InvalidInputError);
    await expect(
      loktin.read('target-savings', 'goal', { id: 'seven' }),
    ).rejects.toThrow(InvalidInputError);
    await expect(loktin.read('target-savings', 'goal', {})).rejects.toThrow(
      InvalidInputError,
    );
    expect(server.calls).toEqual([]);
  });

  it('retry network errors up to 3 times, after 0.5 s, 1 s and 2 s', async () => {
    vi.useFakeTimers();
    server.simulations.push(
      new Error('fetch failed'),
      new Error('fetch failed'),
      new Error('fetch failed'),
    );
    server.simulations.push(simulationSuccess(ScVal.scvU64(1n)));
    const loktin = createLoktin({ network: 'testnet', server });
    const result = loktin.read('target-savings', 'next_id');

    await vi.advanceTimersByTimeAsync(0);
    expect(server.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(server.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(result).resolves.toBe(1n);
    expect(server.calls).toHaveLength(4);
  });

  it('give up with NETWORK after 3 retries', async () => {
    vi.useFakeTimers();
    server.simulations.push(new Error('fetch failed'));
    const loktin = createLoktin({ network: 'testnet', server });
    const result = loktin
      .read('target-savings', 'next_id')
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await result;
    expect(error).toBeInstanceOf(NetworkError);
    expect(error).toMatchObject({ code: 'NETWORK' });
    expect(server.calls).toHaveLength(4);
  });

  it('never retry a contract error', async () => {
    vi.useFakeTimers();
    server.simulations.push(
      simulationFailure('HostError', [
        errorEvent(TESTNET.contracts.targetSavings, 100),
      ]),
    );
    const loktin = createLoktin({ network: 'testnet', server });
    const result = loktin
      .read('target-savings', 'goal', { id: 1n })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBeInstanceOf(ContractError);
    expect(server.calls).toHaveLength(1);
  });
});
