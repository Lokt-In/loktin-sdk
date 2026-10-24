import { StrKey } from '@stellar/stellar-sdk/base';
import type { Api } from '@stellar/stellar-sdk/rpc';
import type { DiagnosticEvent } from '@stellar/stellar-sdk/xdr';
import type { ContractIds } from './networks.js';
import { type LoktinContract, specs } from './specs.js';

/** The stable code of every error the SDK throws (K7). */
export type LoktinErrorCode =
  | 'INVALID_INPUT'
  | 'CONTRACT_ERROR'
  | 'TOKEN_ERROR'
  | 'UNKNOWN_CONTRACT_ERROR'
  | 'SIGNER_REFUSED'
  | 'NETWORK'
  | 'PENDING'
  | 'TRANSACTION_FAILED';

/** Base class of every error the SDK throws. Check `code` to tell them apart. */
export class LoktinError extends Error {
  override readonly name: string = 'LoktinError';
  readonly code: LoktinErrorCode;

  constructor(code: LoktinErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/** An input was rejected before any network call. */
export class InvalidInputError extends LoktinError {
  override readonly name = 'InvalidInputError';
  declare readonly code: 'INVALID_INPUT';

  constructor(message: string, options?: ErrorOptions) {
    super('INVALID_INPUT', message, options);
  }
}

/** One of the Loktin contracts returned one of its documented error codes. */
export class ContractError extends LoktinError {
  override readonly name = 'ContractError';
  declare readonly code: 'CONTRACT_ERROR';
  readonly contract: LoktinContract;
  readonly contractId: string;
  readonly number: number;
  /** The error's name in the contract, such as `GoalNotFound`. */
  readonly errorName: string;
  /** The error's documented meaning. */
  readonly description: string;

  constructor(
    contract: LoktinContract,
    contractId: string,
    number: number,
    errorName: string,
    description: string,
  ) {
    super(
      'CONTRACT_ERROR',
      `${contract} error ${String(number)} ${errorName}: ${description}`,
    );
    this.contract = contract;
    this.contractId = contractId;
    this.number = number;
    this.errorName = errorName;
    this.description = description;
  }
}

/** The configured token contract returned one of its error codes. */
export class TokenError extends LoktinError {
  override readonly name = 'TokenError';
  declare readonly code: 'TOKEN_ERROR';
  readonly contractId: string;
  readonly number: number;
  /** The error's name in the Stellar Asset Contract, such as `Allowance`. */
  readonly errorName: string;

  constructor(contractId: string, number: number, errorName: string) {
    super('TOKEN_ERROR', `token error ${String(number)} ${errorName}`);
    this.contractId = contractId;
    this.number = number;
    this.errorName = errorName;
  }
}

/**
 * A contract error the SDK cannot name: another contract raised it, the code
 * is not in the contract's table, or the failure carried no error event.
 */
export class UnknownContractError extends LoktinError {
  override readonly name = 'UnknownContractError';
  declare readonly code: 'UNKNOWN_CONTRACT_ERROR';
  readonly contractId: string | undefined;
  readonly number: number | undefined;

  constructor(message: string, contractId?: string, number?: number) {
    super('UNKNOWN_CONTRACT_ERROR', message);
    this.contractId = contractId;
    this.number = number;
  }
}

/** The wallet refused to sign, or failed while signing. */
export class SignerRefusedError extends LoktinError {
  override readonly name = 'SignerRefusedError';
  declare readonly code: 'SIGNER_REFUSED';
  /** The wallet's error code, such as -4 when the user rejected the request. */
  readonly walletCode: number | undefined;
  readonly walletMessage: string;

  constructor(
    walletCode: number | undefined,
    walletMessage: string,
    options?: ErrorOptions,
  ) {
    super('SIGNER_REFUSED', `the signer refused: ${walletMessage}`, options);
    this.walletCode = walletCode;
    this.walletMessage = walletMessage;
  }
}

/** The RPC could not be reached, or answered with an RPC error. */
export class NetworkError extends LoktinError {
  override readonly name = 'NetworkError';
  declare readonly code: 'NETWORK';

  constructor(message: string, options?: ErrorOptions) {
    super('NETWORK', message, options);
  }
}

/**
 * The transaction was sent, and its outcome is not known yet. It may still
 * succeed until `validUntil`. Look it up by `hash` instead of sending a new one.
 */
export class PendingError extends LoktinError {
  override readonly name = 'PendingError';
  declare readonly code: 'PENDING';
  readonly hash: string;
  /** When the transaction stops being valid, from its time bounds. */
  readonly validUntil: Date | undefined;

  constructor(hash: string, validUntil: Date | undefined) {
    const until =
      validUntil === undefined
        ? ''
        : ` It is valid until ${validUntil.toISOString()}.`;
    super(
      'PENDING',
      `transaction ${hash} was sent and its outcome is not known yet.${until}`,
    );
    this.hash = hash;
    this.validUntil = validUntil;
  }
}

/** The transaction was sent and failed. */
export class TransactionFailedError extends LoktinError {
  override readonly name = 'TransactionFailedError';
  declare readonly code: 'TRANSACTION_FAILED';
  readonly hash: string;
  /** The transaction result code, such as `txFailed` or `txBadSeq`. */
  readonly resultCode: string | undefined;
  /** The contract error that caused the failure, when diagnostic events name one. */
  readonly origin: LoktinError | undefined;

  constructor(
    hash: string,
    resultCode: string | undefined,
    origin: LoktinError | undefined,
  ) {
    const code = resultCode === undefined ? '' : ` (${resultCode})`;
    const cause = origin === undefined ? '' : `: ${origin.message}`;
    super(
      'TRANSACTION_FAILED',
      `transaction ${hash} failed${code}${cause}`,
      origin === undefined ? undefined : { cause: origin },
    );
    this.hash = hash;
    this.resultCode = resultCode;
    this.origin = origin;
  }
}

interface ErrorCase {
  readonly name: string;
  readonly description: string;
}

// Built from the contract specs' error enums, so no table is copied by hand.
function tableFromSpec(
  contract: LoktinContract,
): ReadonlyMap<number, ErrorCase> {
  const table = new Map<number, ErrorCase>();
  for (const errorCase of specs[contract].errorCases()) {
    const name = errorCase.name.toString();
    const doc = errorCase.doc.toString().trim();
    table.set(errorCase.value, { name, description: doc === '' ? name : doc });
  }
  return table;
}

const contractTables: Readonly<
  Record<LoktinContract, ReadonlyMap<number, ErrorCase>>
> = {
  'target-savings': tableFromSpec('target-savings'),
  'spend-save': tableFromSpec('spend-save'),
};

// Stellar Asset Contract error codes, from rs-soroban-env
// soroban-env-host/src/builtin_contracts/contract_error.rs. Code 1 is reserved.
const tokenTable: ReadonlyMap<number, string> = new Map([
  [2, 'OperationNotSupported'],
  [3, 'AlreadyInitialized'],
  [4, 'Unauthorized'],
  [5, 'Authentication'],
  [6, 'AccountMissing'],
  [7, 'AccountIsNotClassic'],
  [8, 'NegativeAmount'],
  [9, 'Allowance'],
  [10, 'Balance'],
  [11, 'BalanceDeauthorized'],
  [12, 'Overflow'],
  [13, 'TrustlineMissing'],
  [14, 'InsufficientAccountReserve'],
  [15, 'TooManyAccountSubentries'],
]);

/** The contracts a deployment uses, to tell who raised an error. */
export interface ErrorOrigins {
  readonly contracts: ContractIds;
  readonly token: string;
}

/** Maps a contract id and error code to the error of the contract that raised it. */
export function contractErrorFor(
  contractId: string,
  number: number,
  origins: ErrorOrigins,
): LoktinError {
  const contract: LoktinContract | undefined =
    contractId === origins.contracts.targetSavings
      ? 'target-savings'
      : contractId === origins.contracts.spendSave
        ? 'spend-save'
        : undefined;
  if (contract !== undefined) {
    const errorCase = contractTables[contract].get(number);
    if (errorCase !== undefined) {
      return new ContractError(
        contract,
        contractId,
        number,
        errorCase.name,
        errorCase.description,
      );
    }
    return new UnknownContractError(
      `${contract} raised error ${String(number)}, which its spec does not list`,
      contractId,
      number,
    );
  }
  if (contractId === origins.token) {
    const name = tokenTable.get(number);
    if (name !== undefined) {
      return new TokenError(contractId, number, name);
    }
    return new UnknownContractError(
      `the token raised unknown error ${String(number)}`,
      contractId,
      number,
    );
  }
  return new UnknownContractError(
    `contract ${contractId} raised error ${String(number)}`,
    contractId,
    number,
  );
}

// The contract and code of a diagnostic event whose topics are the symbol
// `error` and a contract error, or undefined for any other event.
function errorOf(
  event: DiagnosticEvent,
): { contractId: string; code: number } | undefined {
  const { contractId, body } = event.event;
  const [first, second] = body.v0.topics;
  if (
    contractId !== null &&
    first?.type === 'scvSymbol' &&
    first.sym.toString() === 'error' &&
    second?.type === 'scvError' &&
    second.error.type === 'sceContract'
  ) {
    return {
      contractId: StrKey.encodeContract(contractId.value),
      code: second.error.contractCode,
    };
  }
  return undefined;
}

/**
 * Finds the contract that raised a failure. The host keeps the events of inner
 * calls that failed and were handled, so the first error event may not be the
 * failure. The last error event has the code that failed the call. Each caller
 * that passes the error on adds an event with the same code, so the walk goes
 * back while the event just before is an error event with that code. The event
 * it stops on names the contract that raised the error.
 */
export function errorFromEvents(
  events: readonly DiagnosticEvent[] | undefined,
  origins: ErrorOrigins,
): LoktinError | undefined {
  const errors = (events ?? []).map(errorOf);
  let index = errors.length - 1;
  while (index >= 0 && errors[index] === undefined) {
    index -= 1;
  }
  let found = errors[index];
  if (found === undefined) {
    return undefined;
  }
  let before = errors[index - 1];
  while (before !== undefined && before.code === found.code) {
    found = before;
    index -= 1;
    before = errors[index - 1];
  }
  return contractErrorFor(found.contractId, found.code, origins);
}

/** Maps a failed simulation to the error of the contract that raised it. */
export function simulationError(
  sim: Api.SimulateTransactionErrorResponse,
  origins: ErrorOrigins,
): LoktinError {
  return (
    errorFromEvents(sim.events, origins) ??
    new UnknownContractError(`simulation failed: ${sim.error}`)
  );
}
