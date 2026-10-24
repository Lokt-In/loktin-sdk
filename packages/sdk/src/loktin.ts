import type { Transaction } from '@stellar/stellar-sdk/base';
import {
  AssembledTransaction,
  Client,
  type MethodOptions,
  type SignTransaction,
  type Spec,
  type WalletError,
} from '@stellar/stellar-sdk/contract';
import { Api, Server } from '@stellar/stellar-sdk/rpc';
import {
  ConfigSettingId,
  LedgerKey,
  LedgerKeyConfigSetting,
  type ScVal,
} from '@stellar/stellar-sdk/xdr';
import {
  type LoktinOptions,
  type ResolvedConfig,
  resolveConfig,
} from './config.js';
import {
  InvalidInputError,
  NetworkError,
  PendingError,
  SignerRefusedError,
  TransactionFailedError,
  UnknownContractError,
  errorFromEvents,
  simulationError,
} from './errors.js';
import { type LoktinContract, specs } from './specs.js';

/** Named arguments of a contract function, as the stellar-sdk contract client takes them. */
export type ContractArgs = Readonly<Record<string, unknown>>;

/** A contract the SDK calls: one of the Loktin contracts, or the configured token. */
export type CallTarget = LoktinContract | 'token';

/** Network limits read from the ledger, for allowance expiries (W57). */
export interface LedgerInfo {
  /** The latest ledger the RPC knows. */
  readonly latestLedger: number;
  /** The longest time to live of a ledger entry, in ledgers. */
  readonly maxEntryTtl: number;
}

/** The outcome of a successful write. */
export interface WriteResult<T> {
  readonly hash: string;
  readonly ledger: number;
  /** The function's return value, decoded with the contract spec. */
  readonly result: T;
}

/** A configured Loktin SDK instance. */
export interface Loktin {
  readonly config: ResolvedConfig;
  /**
   * Simulates a read-only call (G8, K9). It costs one RPC call, retried on
   * network errors only. The first token call also looks up the token
   * contract, once per instance (W58).
   */
  read<T = unknown>(
    contract: CallTarget,
    method: string,
    args?: ContractArgs,
  ): Promise<T>;
  /** Builds, simulates, signs, sends and confirms a call (K5, K6). */
  write<T = unknown>(
    contract: CallTarget,
    method: string,
    args?: ContractArgs,
  ): Promise<WriteResult<T>>;
  /** Reads the latest ledger and the longest entry time to live, in one RPC call (W57). */
  ledgerInfo(): Promise<LedgerInfo>;
}

// K9: a read is retried up to 3 times, on network errors only.
const READ_RETRY_DELAYS_MS = [500, 1000, 2000];
// K6: TRY_AGAIN_LATER resends the same signed transaction up to 3 times.
const RESEND_DELAYS_MS = [1000, 2000, 4000];
const POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1000;

const WALLET_ERRORS: readonly [new (message: string) => Error, number][] = [
  [AssembledTransaction.Errors.InternalWalletError, -1],
  [AssembledTransaction.Errors.ExternalServiceError, -2],
  [AssembledTransaction.Errors.InvalidClientRequest, -3],
  [AssembledTransaction.Errors.UserRejected, -4],
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  // The RPC client rejects some lookups with a plain `{ code, message }`.
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return String(error);
}

const STATE_ARCHIVAL_KEY = LedgerKey.configSetting(
  new LedgerKeyConfigSetting({
    configSettingId: ConfigSettingId.configSettingStateArchival,
  }),
);

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

function validUntil(tx: Transaction): Date | undefined {
  const maxTime = Number(tx.timeBounds?.maxTime ?? '0');
  return maxTime > 0 ? new Date(maxTime * 1000) : undefined;
}

// Decodes a return value. For a function returning Result, the value is the Ok part.
function decode(spec: Spec, method: string, value: ScVal | undefined): unknown {
  const [output] = spec.getFunc(method).outputs;
  if (output === undefined || value === undefined) {
    return null;
  }
  const type =
    output.type === 'scSpecTypeResult' ? output.result.okType : output;
  return spec.scValToNative(value, type);
}

class LoktinInstance implements Loktin {
  readonly config: ResolvedConfig;
  private readonly server: Server;
  private readonly readClients = new Map<CallTarget, Client>();
  private readonly writeClients = new Map<CallTarget, Client>();
  private networkCheck: Promise<void> | undefined;
  private tokenLookup: Promise<Spec> | undefined;

  constructor(config: ResolvedConfig) {
    this.config = config;
    this.server =
      config.server ??
      new Server(config.rpcUrl, { allowHttp: config.allowHttp });
  }

  async read<T = unknown>(
    contract: CallTarget,
    method: string,
    args: ContractArgs = {},
  ): Promise<T> {
    return this.retrying(async () => {
      const spec = await this.specFor(contract);
      checkCall(spec, method, args);
      const client = this.client(this.readClients, contract, spec, false);
      return (await this.readOnce(client, spec, method, args)) as T;
    });
  }

  async write<T = unknown>(
    contract: CallTarget,
    method: string,
    args: ContractArgs = {},
  ): Promise<WriteResult<T>> {
    const { publicKey, signer } = this.config;
    if (publicKey === undefined || signer === undefined) {
      throw new InvalidInputError(
        'a write needs publicKey and signer in createLoktin',
      );
    }
    // No network call for the Loktin contracts, whose specs are bundled.
    const spec = await this.specFor(contract);
    checkCall(spec, method, args);
    await this.checkNetwork();

    // K5: built with the user's address, so the account is looked up.
    const tx = await this.simulate(
      this.client(this.writeClients, contract, spec, true),
      spec,
      method,
      args,
    );
    const simulation = tx.simulation;
    if (simulation !== undefined && Api.isSimulationRestore(simulation)) {
      throw new UnknownContractError(
        `the simulation of ${method} asked for a separate restore transaction, which the SDK never sends`,
      );
    }

    await this.sign(tx, signer.signTransaction, method);
    const signed = tx.signed;
    if (signed === undefined) {
      throw new SignerRefusedError(
        undefined,
        'the signer returned no transaction',
      );
    }
    const hash = await this.send(signed);
    return this.confirm<T>(signed, hash, spec, method);
  }

  async ledgerInfo(): Promise<LedgerInfo> {
    return this.retrying(async () => {
      let response: Api.GetLedgerEntriesResponse;
      try {
        response = await this.server.getLedgerEntries(STATE_ARCHIVAL_KEY);
      } catch (error) {
        throw new NetworkError(
          `could not read the ledger settings: ${messageOf(error)}`,
          { cause: error },
        );
      }
      const entry = response.entries[0]?.val;
      if (
        entry?.type !== 'configSetting' ||
        entry.configSetting.type !== 'configSettingStateArchival'
      ) {
        throw new UnknownContractError(
          'the RPC returned no state archival settings',
        );
      }
      return {
        latestLedger: response.latestLedger,
        maxEntryTtl: entry.configSetting.stateArchivalSettings.maxEntryTtl,
      };
    });
  }

  // K9: retried up to 3 times, on network errors only.
  private async retrying<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        const delay = READ_RETRY_DELAYS_MS[attempt];
        if (!(error instanceof NetworkError) || delay === undefined) {
          throw error;
        }
        await sleep(delay);
      }
    }
  }

  // The Loktin specs are bundled. The token's comes from one lookup per
  // instance, which recognises the Stellar Asset Contract (W58).
  private specFor(contract: CallTarget): Spec | Promise<Spec> {
    if (contract !== 'token') {
      return specs[contract];
    }
    const { token, passphrase, rpcUrl, allowHttp } = this.config;
    this.tokenLookup ??= Client.from({
      contractId: token,
      networkPassphrase: passphrase,
      rpcUrl,
      allowHttp,
      server: this.server,
    }).then(
      (client) => client.spec,
      (error: unknown) => {
        this.tokenLookup = undefined;
        throw new NetworkError(
          `could not look up the token contract ${token}: ${messageOf(error)}`,
          { cause: error },
        );
      },
    );
    return this.tokenLookup;
  }

  private contractIdOf(contract: CallTarget): string {
    const { contracts, token } = this.config;
    switch (contract) {
      case 'target-savings':
        return contracts.targetSavings;
      case 'spend-save':
        return contracts.spendSave;
      case 'token':
        return token;
    }
  }

  private client(
    cache: Map<CallTarget, Client>,
    contract: CallTarget,
    spec: Spec,
    forWrite: boolean,
  ): Client {
    let client = cache.get(contract);
    if (client === undefined) {
      const { passphrase, rpcUrl, allowHttp, publicKey, signer } = this.config;
      client = new Client(spec, {
        contractId: this.contractIdOf(contract),
        networkPassphrase: passphrase,
        rpcUrl,
        allowHttp,
        server: this.server,
        // A read has no publicKey, so it makes no account lookup (G8).
        ...(forWrite && publicKey !== undefined ? { publicKey } : {}),
        ...(forWrite && signer?.signAuthEntry !== undefined
          ? { signAuthEntry: signer.signAuthEntry }
          : {}),
      });
      cache.set(contract, client);
    }
    return client;
  }

  private async readOnce(
    client: Client,
    spec: Spec,
    method: string,
    args: ContractArgs,
  ): Promise<unknown> {
    const tx = await this.simulate(client, spec, method, args);
    const simulation = tx.simulation;
    if (simulation === undefined || !Api.isSimulationSuccess(simulation)) {
      throw new UnknownContractError(
        `the simulation of ${method} returned no result`,
      );
    }
    return decode(spec, method, simulation.result?.retval);
  }

  // Builds the call and simulates it, with restore left off (K5).
  private async simulate(
    client: Client,
    spec: Spec,
    method: string,
    args: ContractArgs,
  ): Promise<AssembledTransaction<unknown>> {
    const options: MethodOptions = { simulate: false, restore: false };
    const build = (
      client as unknown as Record<
        string,
        (...params: unknown[]) => Promise<AssembledTransaction<unknown>>
      >
    )[method];
    if (build === undefined) {
      throw new InvalidInputError(`the contract has no function ${method}`);
    }
    let tx: AssembledTransaction<unknown>;
    try {
      tx = await (spec.getFunc(method).inputs.length === 0
        ? build(options)
        : build(args, options));
    } catch (error) {
      // Arguments were checked already, so for a write this is the account
      // lookup. stellar-sdk reports every lookup failure as "Account not found".
      const { publicKey } = client.options;
      throw new NetworkError(
        publicKey === undefined
          ? `could not build the call to ${method}: ${messageOf(error)}`
          : `could not load account ${publicKey}: it may not exist on this network yet (an account is created by sending it XLM), or the RPC could not be reached`,
        { cause: error },
      );
    }
    try {
      await tx.simulate();
    } catch (error) {
      throw new NetworkError(
        `could not simulate ${method}: ${messageOf(error)}`,
        { cause: error },
      );
    }
    const simulation = tx.simulation;
    if (simulation !== undefined && Api.isSimulationError(simulation)) {
      throw simulationError(simulation, this.config);
    }
    return tx;
  }

  // K5: once per instance, confirm the RPC serves the configured network.
  private checkNetwork(): Promise<void> {
    this.networkCheck ??= (async () => {
      let passphrase: string;
      try {
        ({ passphrase } = await this.server.getNetwork());
      } catch (error) {
        this.networkCheck = undefined;
        throw new NetworkError(
          `could not read the RPC's network: ${messageOf(error)}`,
          { cause: error },
        );
      }
      if (passphrase !== this.config.passphrase) {
        throw new NetworkError(
          `the RPC serves the network "${passphrase}", not the configured "${this.config.passphrase}"`,
        );
      }
    })();
    return this.networkCheck;
  }

  private async sign(
    tx: AssembledTransaction<unknown>,
    signTransaction: SignTransaction,
    method: string,
  ): Promise<void> {
    // What the wallet did, recorded by the wrapper below.
    const wallet: { called: boolean; error: WalletError | undefined } = {
      called: false,
      error: undefined,
    };
    const wrapped: SignTransaction = async (xdr, opts) => {
      wallet.called = true;
      const response = await signTransaction(xdr, opts);
      wallet.error = response.error;
      return response;
    };
    try {
      // sign() resets the time bounds right before calling the signer.
      await tx.sign({ signTransaction: wrapped });
    } catch (error) {
      if (wallet.error !== undefined) {
        throw new SignerRefusedError(wallet.error.code, wallet.error.message, {
          cause: error,
        });
      }
      if (wallet.called) {
        const code = WALLET_ERRORS.find(([type]) => error instanceof type)?.[1];
        throw new SignerRefusedError(code, messageOf(error), { cause: error });
      }
      if (error instanceof AssembledTransaction.Errors.NeedsMoreSignatures) {
        // The SDK signs for the user only, and never asks for a second signature.
        throw new InvalidInputError(
          `${method} needs a signature from another address; publicKey must be the address the call acts for: ${error.message}`,
        );
      }
      if (error instanceof AssembledTransaction.Errors.NoSignatureNeeded) {
        throw new InvalidInputError(
          `${method} changes nothing on chain; read it instead of writing it`,
        );
      }
      throw error;
    }
  }

  // K6: sends the signed transaction, and resends the same one on TRY_AGAIN_LATER.
  private async send(signed: Transaction): Promise<string> {
    const localHash = hexOf(signed.hash());
    for (let attempt = 0; ; attempt++) {
      let response: Api.SendTransactionResponse;
      try {
        response = await this.server.sendTransaction(signed);
      } catch {
        // It may have reached the network, so its outcome is unknown.
        throw new PendingError(localHash, validUntil(signed));
      }
      switch (response.status) {
        case 'PENDING':
        case 'DUPLICATE':
          return response.hash;
        case 'TRY_AGAIN_LATER': {
          const delay = RESEND_DELAYS_MS[attempt];
          if (delay === undefined) {
            throw new NetworkError(
              `the RPC did not accept transaction ${response.hash} after ${String(RESEND_DELAYS_MS.length)} resends`,
            );
          }
          await sleep(delay);
          break;
        }
        case 'ERROR':
          throw new TransactionFailedError(
            response.hash,
            response.errorResult?.result.type,
            errorFromEvents(response.diagnosticEvents, this.config),
          );
      }
    }
  }

  // K6: polls for up to 60 s, and never builds or signs a new transaction.
  private async confirm<T>(
    signed: Transaction,
    hash: string,
    spec: Spec,
    method: string,
  ): Promise<WriteResult<T>> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      let response: Api.GetTransactionResponse;
      try {
        response = await this.server.getTransaction(hash);
      } catch {
        // A failed poll is retried until the deadline.
        continue;
      }
      if (response.status === Api.GetTransactionStatus.SUCCESS) {
        return {
          hash,
          ledger: response.ledger,
          result: decode(spec, method, response.returnValue) as T,
        };
      }
      if (response.status === Api.GetTransactionStatus.FAILED) {
        throw new TransactionFailedError(
          hash,
          response.resultXdr.result.type,
          errorFromEvents(response.diagnosticEventsXdr, this.config),
        );
      }
    }
    throw new PendingError(hash, validUntil(signed));
  }
}

// Checks the function and its arguments against the spec, before any network call.
function checkCall(spec: Spec, method: string, args: ContractArgs): void {
  if (
    method === '__constructor' ||
    !spec.funcs().some((func) => func.name.toString() === method)
  ) {
    throw new InvalidInputError(`the contract has no function ${method}`);
  }
  try {
    spec.funcArgsToScVals(method, args);
  } catch (error) {
    throw new InvalidInputError(
      `invalid arguments for ${method}: ${messageOf(error)}`,
      { cause: error },
    );
  }
}

/** Creates a configured SDK instance (K10). Options are checked before any network call. */
export function createLoktin(options: LoktinOptions): Loktin {
  return new LoktinInstance(resolveConfig(options));
}
