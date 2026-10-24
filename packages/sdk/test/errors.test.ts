import { StrKey } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { errorFromEvents, simulationError } from '../src/errors.js';
import {
  ContractError,
  TESTNET,
  TokenError,
  UnknownContractError,
  createLoktin,
} from '../src/index.js';
import {
  FakeServer,
  callEvent,
  errorEvent,
  logEvent,
  simulationFailure,
} from './fake-server.js';

const { targetSavings, spendSave } = TESTNET.contracts;
const USDC = TESTNET.token;
// A well-formed contract address that is none of ours.
const OTHER = StrKey.encodeContract(new Uint8Array(32).fill(9));
const origins = { contracts: TESTNET.contracts, token: USDC };

// The failure as the read path sees it, through a fake server.
async function readFailure(
  message: string,
  events: ReturnType<typeof errorEvent>[],
): Promise<unknown> {
  const server = new FakeServer();
  server.simulations.push(simulationFailure(message, events));
  const loktin = createLoktin({ network: 'testnet', server });
  return loktin
    .read('target-savings', 'goal', { id: 7n })
    .catch((error: unknown) => error);
}

describe('error mapping', () => {
  it('maps our code 100 to Target Savings GoalNotFound', async () => {
    const error = await readFailure('HostError: Error(Contract, #100)', [
      callEvent(targetSavings),
      errorEvent(targetSavings, 100),
    ]);
    expect(error).toBeInstanceOf(ContractError);
    expect(error).toMatchObject({
      code: 'CONTRACT_ERROR',
      contract: 'target-savings',
      contractId: targetSavings,
      number: 100,
      errorName: 'GoalNotFound',
      description: 'No open goal has this id.',
    });
  });

  it('maps a USDC code 9 to the token Allowance error, not to our tables', async () => {
    // The top-level message names our contract, but the token raised the error.
    const error = await readFailure(
      `HostError: Error(Contract, #9) contract ${targetSavings}`,
      [
        callEvent(targetSavings),
        callEvent(USDC),
        errorEvent(USDC, 9),
        errorEvent(targetSavings, 9),
      ],
    );
    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      code: 'TOKEN_ERROR',
      contractId: USDC,
      number: 9,
      errorName: 'Allowance',
    });
  });

  it('skips the error of a handled inner call, and names the token that failed pay_and_save', () => {
    // The destination goal was closed (handled), then the payee had no trustline.
    const error = errorFromEvents(
      [
        callEvent(targetSavings),
        errorEvent(targetSavings, 100),
        callEvent(USDC),
        errorEvent(USDC, 13),
        errorEvent(spendSave, 13),
        errorEvent(spendSave, 13),
        logEvent(spendSave),
      ],
      origins,
    );
    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({
      code: 'TOKEN_ERROR',
      contractId: USDC,
      number: 13,
      errorName: 'TrustlineMissing',
    });
  });

  it('stops the walk back at an event that is not an error event', () => {
    const error = errorFromEvents(
      [
        errorEvent(USDC, 10),
        callEvent(targetSavings),
        errorEvent(targetSavings, 112),
      ],
      origins,
    );
    expect(error).toBeInstanceOf(ContractError);
    expect(error).toMatchObject({
      code: 'CONTRACT_ERROR',
      contract: 'target-savings',
      number: 112,
      errorName: 'Shortfall',
    });
  });

  it("maps a token code 4 to the token's Unauthorized, never to our InvalidDay", () => {
    const error = errorFromEvents(
      [errorEvent(USDC, 4), errorEvent(spendSave, 4)],
      origins,
    );
    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({ number: 4, errorName: 'Unauthorized' });
    // The same code from our contract is ours.
    expect(errorFromEvents([errorEvent(spendSave, 4)], origins)).toMatchObject({
      contract: 'spend-save',
      errorName: 'InvalidDay',
    });
  });

  it('maps an unknown contract to UNKNOWN_CONTRACT_ERROR', () => {
    const error = errorFromEvents([errorEvent(OTHER, 100)], origins);
    expect(error).toBeInstanceOf(UnknownContractError);
    expect(error).toMatchObject({
      code: 'UNKNOWN_CONTRACT_ERROR',
      contractId: OTHER,
      number: 100,
    });
  });

  it("maps OpenZeppelin's 1000 and 2203 from both contracts", () => {
    expect(
      errorFromEvents([errorEvent(targetSavings, 1000)], origins),
    ).toMatchObject({
      code: 'CONTRACT_ERROR',
      contract: 'target-savings',
      errorName: 'EnforcedPause',
    });
    expect(
      errorFromEvents([errorEvent(spendSave, 2203)], origins),
    ).toMatchObject({
      code: 'CONTRACT_ERROR',
      contract: 'spend-save',
      errorName: 'TransferExpired',
      description: 'TransferExpired',
    });
  });

  it('maps each contract to its own table', () => {
    expect(
      errorFromEvents([errorEvent(spendSave, 200)], origins),
    ).toMatchObject({ errorName: 'EnrollmentNotFound' });
    // 200 is not a Target Savings code.
    expect(
      errorFromEvents([errorEvent(targetSavings, 200)], origins),
    ).toMatchObject({
      code: 'UNKNOWN_CONTRACT_ERROR',
      contractId: targetSavings,
      number: 200,
    });
  });

  it('maps a token code outside the table to UNKNOWN_CONTRACT_ERROR', () => {
    expect(errorFromEvents([errorEvent(USDC, 1)], origins)).toMatchObject({
      code: 'UNKNOWN_CONTRACT_ERROR',
      number: 1,
    });
  });

  it('uses UNKNOWN_CONTRACT_ERROR with the raw message when no error event is found', async () => {
    const error = await readFailure('HostError: Error(Budget, ExceededLimit)', [
      callEvent(targetSavings),
    ]);
    expect(error).toBeInstanceOf(UnknownContractError);
    expect(error).toMatchObject({ contractId: undefined, number: undefined });
    expect((error as Error).message).toContain('Error(Budget, ExceededLimit)');
  });

  it('reads the events of a parsed simulation', () => {
    const sim = simulationFailure('failed', [errorEvent(targetSavings, 112)]);
    if (!('error' in sim)) throw new Error('expected a failed simulation');
    expect(simulationError(sim, origins)).toMatchObject({
      errorName: 'Shortfall',
    });
  });
});
