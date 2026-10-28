import {
  Account,
  Address,
  Keypair,
  SorobanDataBuilder,
  StrKey,
  type Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk/base';
import { Api, Server, parseRawSimulation } from '@stellar/stellar-sdk/rpc';
import {
  ConfigSettingEntry,
  ContractDataDurability,
  ContractDataEntry,
  ContractEvent,
  ContractEventBody,
  ContractEventType,
  ContractEventV0,
  ContractExecutable,
  ContractId,
  DiagnosticEvent,
  ExtensionPoint,
  InvokeContractArgs,
  LedgerEntryData,
  LedgerKey,
  LedgerKeyAccount,
  ScContractInstance,
  ScError,
  ScVal,
  SorobanAddressCredentials,
  SorobanAuthorizationEntry,
  SorobanAuthorizedFunction,
  SorobanAuthorizedInvocation,
  SorobanCredentials,
  StateArchivalSettings,
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
  options: { restore?: boolean; auth?: SorobanAuthorizationEntry[] } = {},
): Api.SimulateTransactionResponse {
  return parseRawSimulation({
    id: '1',
    latestLedger: 100,
    transactionData: WRITE_DATA,
    minResourceFee: '1000',
    results: [
      {
        auth: (options.auth ?? []).map((entry) => entry.toXdr('base64')),
        xdr: retval.toXdr('base64'),
      },
    ],
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

/** An authorisation entry that still needs a signature from `address`. */
export function authEntryFor(
  address: string,
  contractId: string,
): SorobanAuthorizationEntry {
  return new SorobanAuthorizationEntry({
    credentials: SorobanCredentials.sorobanCredentialsAddress(
      new SorobanAddressCredentials({
        address: new Address(address).toScAddress(),
        nonce: 1n,
        signatureExpirationLedger: 0,
        signature: ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new SorobanAuthorizedInvocation({
      function:
        SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new InvokeContractArgs({
            contractAddress: new Address(contractId).toScAddress(),
            functionName: 'deposit',
            args: [],
          }),
        ),
      subInvocations: [],
    }),
  });
}

/** The contract call inside a transaction the SDK built. */
export interface Invocation {
  readonly contractId: string;
  readonly method: string;
  readonly args: readonly ScVal[];
}

export function invocationOf(envelope: string): Invocation {
  const tx = TransactionBuilder.fromXdr(envelope, TESTNET_PASSPHRASE);
  const [operation] = (tx as Transaction).operations;
  if (operation?.type !== 'invokeHostFunction') {
    throw new Error('expected an invokeHostFunction operation');
  }
  const { func } = operation;
  if (func.type !== 'hostFunctionTypeInvokeContract') {
    throw new Error('expected a contract call');
  }
  const call = func.invokeContract;
  return {
    contractId: Address.fromScAddress(call.contractAddress).toString(),
    method: call.functionName.toString(),
    args: call.args,
  };
}

type Responder<T> = T | Error | (() => T | Error);

/** One call the SDK made to the server. */
export interface Call {
  readonly method:
    | 'getNetwork'
    | 'getAccount'
    | 'simulateTransaction'
    | 'sendTransaction'
    | 'getTransaction'
    | 'getLedgerEntries';
  /** The envelope, for simulateTransaction and sendTransaction. */
  readonly envelope?: string;
  /** The key types, for getLedgerEntries. */
  readonly keys?: readonly string[];
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
  /** One-off failures of getAccount, used up in order before `accountError`. */
  readonly accountErrors: Error[] = [];
  /** One-off failures of getNetwork, used up in order. */
  readonly networkErrors: Error[] = [];
  /** When set, answers simulations by the call, before the queue. */
  simulateBy:
    | ((call: Invocation) => Api.SimulateTransactionResponse | undefined)
    | undefined;
  latestLedger = 1_000_000;
  maxEntryTtl = 3_110_400;

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
    const error = this.networkErrors.shift();
    if (error !== undefined) {
      return Promise.reject(error);
    }
    return Promise.resolve({
      passphrase: this.passphrase,
      protocolVersion: '25',
    });
  }

  override getAccount(address: string): Promise<Account> {
    this.calls.push({ method: 'getAccount' });
    const error = this.accountErrors.shift() ?? this.accountError;
    if (error !== undefined) {
      return Promise.reject(error);
    }
    return Promise.resolve(new Account(address, '100'));
  }

  override simulateTransaction(
    tx: Transaction,
  ): Promise<Api.SimulateTransactionResponse> {
    const envelope = tx.toXdr();
    this.calls.push({ method: 'simulateTransaction', envelope });
    const answer = this.simulateBy?.(invocationOf(envelope));
    return Promise.resolve().then(
      () => answer ?? this.next(this.simulations, 'simulateTransaction'),
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

  // Answers a contract instance key with a Stellar Asset Contract, and the
  // state archival key with `maxEntryTtl`.
  override getLedgerEntries(
    ...keys: LedgerKey[]
  ): Promise<Api.GetLedgerEntriesResponse> {
    this.calls.push({
      method: 'getLedgerEntries',
      keys: keys.map((key) => key.type),
    });
    const entries = keys.map((key) => ({
      key,
      val:
        key.type === 'contractData'
          ? LedgerEntryData.contractData(
              new ContractDataEntry({
                ext: ExtensionPoint.v0(),
                contract: key.contractData.contract,
                key: ScVal.scvLedgerKeyContractInstance(),
                durability: ContractDataDurability.persistent,
                val: ScVal.scvContractInstance(
                  new ScContractInstance({
                    executable:
                      ContractExecutable.contractExecutableStellarAsset(),
                    storage: null,
                  }),
                ),
              }),
            )
          : LedgerEntryData.configSetting(
              ConfigSettingEntry.configSettingStateArchival(
                new StateArchivalSettings({
                  maxEntryTtl: this.maxEntryTtl,
                  minTemporaryTtl: 17_280,
                  minPersistentTtl: 2_073_600,
                  persistentRentRateDenominator: 1n,
                  tempRentRateDenominator: 1n,
                  maxEntriesToArchive: 1000,
                  liveSorobanStateSizeWindowSampleSize: 30,
                  liveSorobanStateSizeWindowSamplePeriod: 64,
                  evictionScanSize: 100_000,
                  startingEvictionScanLevel: 6,
                }),
              ),
            ),
    }));
    return Promise.resolve({ entries, latestLedger: this.latestLedger });
  }

  /** The contract calls of every simulation, oldest first. */
  invocations(): Invocation[] {
    return this.calls
      .filter((call) => call.method === 'simulateTransaction')
      .map((call) => invocationOf(call.envelope ?? ''));
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
