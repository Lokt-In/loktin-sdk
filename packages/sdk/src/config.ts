import { StrKey } from '@stellar/stellar-sdk/base';
import type {
  SignAuthEntry,
  SignTransaction,
} from '@stellar/stellar-sdk/contract';
import type { Server } from '@stellar/stellar-sdk/rpc';
import { InvalidInputError } from './errors.js';
import type { SpendSaveReadAdapter } from './spend-save/types.js';
import type { TargetSavingsReadAdapter } from './target-savings/types.js';
import {
  type ContractIds,
  type NetworkSettings,
  PUBLIC_PASSPHRASE,
  TESTNET,
} from './networks.js';

/** The wallet that signs writes (K3), in the stellar-sdk and SEP-43 shapes. */
export interface LoktinSigner {
  readonly signTransaction: SignTransaction;
  readonly signAuthEntry?: SignAuthEntry;
}

/**
 * Serves reads from somewhere other than the chain, such as an indexer (K9).
 * Each module read has an optional method here. A read whose method is
 * present uses it; any other read goes to the chain. Writes never use it.
 */
export interface ReadAdapter {
  readonly targetSavings?: TargetSavingsReadAdapter;
  readonly spendSave?: SpendSaveReadAdapter;
}

/** The integrator a module works for, and its fee (R4). */
export interface IntegratorOptions {
  /** The integrator's address (G or C), which receives its fees and penalties. */
  readonly integrator: string;
  /** The integrator fee in basis points, at most 100. */
  readonly integratorFeeBps: number;
}

/** Options for {@link createLoktin} (K10). */
export interface LoktinOptions {
  /** `"testnet"` for Loktin's testnet deployment, or the settings of your own deployment (B7). */
  readonly network: 'testnet' | NetworkSettings;
  /** Overrides the network's RPC URL. */
  readonly rpcUrl?: string;
  /** Overrides some or all of the network's contract ids. */
  readonly contracts?: Partial<ContractIds>;
  /** Signs writes. Needed only for writes. */
  readonly signer?: LoktinSigner;
  /** The user's account, which builds and pays for writes. Needed only for writes. */
  readonly publicKey?: string;
  readonly readAdapter?: ReadAdapter;
  /**
   * A stellar-sdk RPC server to use instead of one built from `rpcUrl`. The
   * SDK leaves its settings untouched, including `requestTimeoutMs`.
   */
  readonly server?: Server;
  /**
   * The time limit of every RPC request, in milliseconds: a positive whole
   * number, 30,000 by default. A request that runs out of time is handled
   * like any other failed request (K6). It applies to the server the SDK
   * builds, not to one passed as `server`.
   */
  readonly requestTimeoutMs?: number;
}

/** Checked settings of one {@link createLoktin} instance. */
export interface ResolvedConfig {
  readonly passphrase: string;
  readonly rpcUrl: string;
  readonly allowHttp: boolean;
  readonly contracts: ContractIds;
  readonly token: string;
  readonly signer: LoktinSigner | undefined;
  readonly publicKey: string | undefined;
  readonly readAdapter: ReadAdapter | undefined;
  readonly server: Server | undefined;
  readonly requestTimeoutMs: number;
}

function contractId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !StrKey.isValidContract(value)) {
    throw new InvalidInputError(`${label} must be a contract address (C...)`);
  }
  return value;
}

// HTTP is allowed only for a local RPC.
function checkRpcUrl(value: unknown): { rpcUrl: string; allowHttp: boolean } {
  if (typeof value !== 'string') {
    throw new InvalidInputError('rpcUrl must be a URL');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new InvalidInputError('rpcUrl must be a URL', { cause: error });
  }
  if (url.protocol === 'https:') {
    return { rpcUrl: value, allowHttp: false };
  }
  if (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  ) {
    return { rpcUrl: value, allowHttp: true };
  }
  throw new InvalidInputError(
    'rpcUrl must use https, or http on localhost or 127.0.0.1',
  );
}

/** The default time limit of every RPC request (K6). stellar-rpc caps a request at 25 s. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function checkTimeout(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidInputError(
      'requestTimeoutMs must be a positive whole number of milliseconds',
    );
  }
  return value;
}

/** Checks the options before any network call. */
export function resolveConfig(options: LoktinOptions): ResolvedConfig {
  const network = options.network === 'testnet' ? TESTNET : options.network;
  if (typeof network !== 'object') {
    throw new InvalidInputError(
      'network must be "testnet" or the settings of a deployment',
    );
  }
  if (typeof network.passphrase !== 'string' || network.passphrase === '') {
    throw new InvalidInputError(
      'network.passphrase must be a network passphrase',
    );
  }
  if (network.passphrase === PUBLIC_PASSPHRASE) {
    throw new InvalidInputError(
      'the public network is not supported in this version',
    );
  }
  const { rpcUrl, allowHttp } = checkRpcUrl(options.rpcUrl ?? network.rpcUrl);
  const contracts: ContractIds = {
    targetSavings: contractId(
      options.contracts?.targetSavings ?? network.contracts.targetSavings,
      'contracts.targetSavings',
    ),
    spendSave: contractId(
      options.contracts?.spendSave ?? network.contracts.spendSave,
      'contracts.spendSave',
    ),
  };
  const token = contractId(network.token, 'network.token');

  const { publicKey, signer } = options;
  if (
    publicKey !== undefined &&
    (typeof publicKey !== 'string' ||
      !StrKey.isValidEd25519PublicKey(publicKey))
  ) {
    throw new InvalidInputError('publicKey must be an account address (G...)');
  }
  if (signer !== undefined && typeof signer.signTransaction !== 'function') {
    throw new InvalidInputError('signer.signTransaction must be a function');
  }
  const requestTimeoutMs = checkTimeout(options.requestTimeoutMs);

  return {
    passphrase: network.passphrase,
    rpcUrl,
    allowHttp,
    contracts,
    token,
    signer,
    publicKey,
    readAdapter: options.readAdapter,
    server: options.server,
    requestTimeoutMs,
  };
}
