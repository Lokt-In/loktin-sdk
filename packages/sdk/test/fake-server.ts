import {
  Account,
  Keypair,
  SorobanDataBuilder,
  StrKey,
  type Transaction,
} from '@stellar/stellar-sdk/base';
import { Api, Server, parseRawSimulation } from '@stellar/stellar-sdk/rpc';
import {
  ContractEvent,
  ContractEventBody,
  ContractEventType,
  ContractEventV0,
  ContractId,
  DiagnosticEvent,
  ExtensionPoint,
  LedgerKey,
  LedgerKeyAccount,
  ScError,
  ScVal,
} from '@stellar/stellar-sdk/xdr';

export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
// A well-formed account address. No key exists for it.
export const USER = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(7));

/** A diagnostic event whose topics are `error` and a contract error, as the host emits it. */
export function errorEvent(contractId: string, code: number): DiagnosticEvent {
  return new DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new ContractEvent({
      ext: ExtensionPoint.v0(),
      contractId: new ContractId(StrKey.decodeContract(contractId)),
      type: ContractEventType.diagnostic,
      body: ContractEventBody.v0(
        new ContractEventV0({
          topics: [
            ScVal.scvSymbol('error'),
            ScVal.scvError(ScError.sceContract(code)),
          ],
          data: ScVal.scvString('failing with contract error'),
        }),
      ),
    }),
  });
}

/** A diagnostic event that is not an error, such as a function call. */
export function logEvent(contractId: string): DiagnosticEvent {
  return new DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new ContractEvent({
      ext: ExtensionPoint.v0(),
      contractId: new ContractId(StrKey.decodeContract(contractId)),
      type: ContractEventType.diagnostic,
      body: ContractEventBody.v0(
        new ContractEventV0({
          topics: [ScVal.scvSymbol('log')],
          data: ScVal.scvString('a log line'),
        }),
      ),
    }),
  });
}

export function callEvent(contractId: string): DiagnosticEvent {
  return new DiagnosticEvent({
    inSuccessfulContractCall: true,
    event: new ContractEvent({
      ext: ExtensionPoint.v0(),
      contractId: new ContractId(StrKey.decodeContract(contractId)),
      type: ContractEventType.diagnostic,
      body: ContractEventBody.v0(
        new ContractEventV0({
          topics: [ScVal.scvSymbol('fn_call')],
          data: ScVal.scvVoid(),
        }),
      ),
    }),
  });
}

// A footprint that writes, so the call is not a read-only call.
const WRITE_DATA = new SorobanDataBuilder()
  .setFootprint(
    [],
    [
      LedgerKey.account(
        new LedgerKeyAccount({
          accountId: Keypair.fromPublicKey(USER).xdrPublicKey(),
        }),
      ),
    ],
  )
  .build()
  .toXdr('base64');

export function simulationSuccess(
  retval: ScVal,
  options: { restore?: boolean } = {},
): Api.SimulateTransactionResponse {
  return parseRawSimulation({
    id: '1',
    latestLedger: 100,
    transactionData: WRITE_DATA,
    minResourceFee: '1000',
    results: [{ auth: [], xdr: retval.toXdr('base64') }],
    events: [],
    ...(options.restore === true
      ? {
          restorePreamble: {
            minResourceFee: '1000',
            transactionData: WRITE_DATA,
          },
        }
      : {}),
  });
}

export function simulationFailure(
  message: string,
  events: DiagnosticEvent[],
): Api.SimulateTransactionResponse {
  return parseRawSimulation({
    id: '1',
    latestLedger: 100,
    error: message,
    events: events.map((event) => event.toXdr('base64')),
  });
}

type Responder<T> = T | Error | (() => T | Error);

/** One call the SDK made to the server. */
export interface Call {
  readonly method:
    | 'getNetwork'
    | 'getAccount'
    | 'simulateTransaction'
    | 'sendTransaction'
    | 'getTransaction';
  /** The envelope, for sendTransaction. */
  readonly envelope?: string;
}

/**
 * A stellar-sdk RPC server that answers from queues and records every call.
 * It never touches the network.
 */
export class FakeServer extends Server {
  readonly calls: Call[] = [];
  passphrase = TESTNET_PASSPHRASE;
  readonly simulations: Responder<Api.SimulateTransactionResponse>[] = [];
  readonly sends: Responder<Api.SendTransactionResponse>[] = [];
  readonly polls: Responder<Api.GetTransactionResponse>[] = [];
  /** When set, getAccount fails with it. */
  accountError: Error | undefined;

  constructor() {
    super('https://rpc.invalid');
  }

  private next<T>(queue: Responder<T>[], name: string): T {
    // The last answer repeats once the queue is down to one.
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    if (answer === undefined) {
      throw new Error(`the fake server has no ${name} answer`);
    }
    const value =
      typeof answer === 'function' ? (answer as () => T | Error)() : answer;
    if (value instanceof Error) {
      throw value;
    }
    return value;
  }

  override getNetwork(): Promise<Api.GetNetworkResponse> {
    this.calls.push({ method: 'getNetwork' });
    return Promise.resolve({
      passphrase: this.passphrase,
      protocolVersion: '25',
    });
  }

  override getAccount(address: string): Promise<Account> {
    this.calls.push({ method: 'getAccount' });
    if (this.accountError !== undefined) {
      return Promise.reject(this.accountError);
    }
    return Promise.resolve(new Account(address, '100'));
  }

  override simulateTransaction(): Promise<Api.SimulateTransactionResponse> {
    this.calls.push({ method: 'simulateTransaction' });
    return Promise.resolve().then(() =>
      this.next(this.simulations, 'simulateTransaction'),
    );
  }

  override sendTransaction(
    tx: Transaction,
  ): Promise<Api.SendTransactionResponse> {
    this.calls.push({ method: 'sendTransaction', envelope: tx.toXdr() });
    return Promise.resolve().then(() =>
      this.next(this.sends, 'sendTransaction'),
    );
  }

  override getTransaction(): Promise<Api.GetTransactionResponse> {
    this.calls.push({ method: 'getTransaction' });
    return Promise.resolve().then(() =>
      this.next(this.polls, 'getTransaction'),
    );
  }

  methods(): Call['method'][] {
    return this.calls.map((call) => call.method);
  }
}

export function sendResponse(
  status: Api.SendTransactionStatus,
  extra: Partial<Api.SendTransactionResponse> = {},
): Api.SendTransactionResponse {
  return {
    status,
    hash: 'ab'.repeat(32),
    latestLedger: 100,
    latestLedgerCloseTime: 0,
    ...extra,
  };
}

export function notFound(): Api.GetTransactionResponse {
  return {
    status: Api.GetTransactionStatus.NOT_FOUND,
    txHash: 'ab'.repeat(32),
    latestLedger: 100,
    latestLedgerCloseTime: 0,
    oldestLedger: 1,
    oldestLedgerCloseTime: 0,
  };
}

// Only the fields the SDK reads are filled in.
export function success(returnValue: ScVal): Api.GetTransactionResponse {
  return {
    ...notFound(),
    status: Api.GetTransactionStatus.SUCCESS,
    ledger: 101,
    returnValue,
  } as Api.GetTransactionResponse;
}

export function failed(
  resultCode: string,
  events: DiagnosticEvent[],
): Api.GetTransactionResponse {
  return {
    ...notFound(),
    status: Api.GetTransactionStatus.FAILED,
    ledger: 101,
    resultXdr: { result: { type: resultCode } },
    diagnosticEventsXdr: events,
  } as unknown as Api.GetTransactionResponse;
}
