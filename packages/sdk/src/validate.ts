// Input checks shared by the modules. Each throws INVALID_INPUT before any
// network call (W59).
import { StrKey } from '@stellar/stellar-sdk/base';
import type { IntegratorOptions, ResolvedConfig } from './config.js';
import { InvalidInputError } from './errors.js';

const U32_MAX = 0xffff_ffff;
const U64_MAX = 0xffff_ffff_ffff_ffffn;

/** Highest Loktin fee rate, 1% (R4). */
export const MAX_LOKTIN_FEE_BPS = 100;
/** Highest integrator fee rate, 1% (R4). */
export const MAX_INTEGRATOR_FEE_BPS = 100;
/** Highest early-withdrawal penalty rate, 10% (P4). */
export const MAX_PENALTY_BPS = 1_000;

export function checkBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint') {
    throw new InvalidInputError(`${label} must be a bigint`);
  }
  return value;
}

/** An amount above zero. `errorName` is the contract error it stands in for. */
export function checkPositive(
  value: unknown,
  label: string,
  errorName: string,
): bigint {
  const amount = checkBigInt(value, label);
  if (amount <= 0n) {
    throw new InvalidInputError(`${label} must be above zero (${errorName})`);
  }
  return amount;
}

export function checkU64(value: unknown, label: string): bigint {
  const number = checkBigInt(value, label);
  if (number < 0n || number > U64_MAX) {
    throw new InvalidInputError(`${label} must be from 0 to 2^64 - 1`);
  }
  return number;
}

export function checkU32(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > U32_MAX
  ) {
    throw new InvalidInputError(
      `${label} must be a whole number from 0 to ${String(U32_MAX)}`,
    );
  }
  return value;
}

/** A rate in basis points, from 0 to `cap`, refused as RateAboveCap above it. */
export function checkBps(value: unknown, label: string, cap: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new InvalidInputError(
      `${label} must be a whole number of basis points`,
    );
  }
  if (value > cap) {
    throw new InvalidInputError(
      `${label} must be at most ${String(cap)} (RateAboveCap)`,
    );
  }
  return value;
}

export function checkDate(value: unknown, label: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidInputError(`${label} must be a valid Date`);
  }
  return value;
}

/** Whole seconds since 1970-01-01 UTC, rounded down. */
export function secondsOf(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** A point in time from a ledger timestamp in seconds. */
export function dateOf(seconds: bigint): Date {
  return new Date(Number(seconds) * 1000);
}

/** An account (G) or contract (C) address. */
export function checkAddress(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !(StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value))
  ) {
    throw new InvalidInputError(
      `${label} must be an account (G...) or contract (C...) address`,
    );
  }
  return value;
}

/** The configured `publicKey`, which every module call acts for. */
export function userOf(config: ResolvedConfig): string {
  if (config.publicKey === undefined) {
    throw new InvalidInputError('this call needs publicKey in createLoktin');
  }
  return config.publicKey;
}

/** The configured `publicKey`, for a write, which also needs a signer. */
export function writerOf(config: ResolvedConfig): string {
  if (config.publicKey === undefined || config.signer === undefined) {
    throw new InvalidInputError(
      'a write needs publicKey and signer in createLoktin',
    );
  }
  return config.publicKey;
}

/** Checks the options both modules take, when the module is created. */
export function checkIntegrator(
  options: unknown,
  contractId: string,
): IntegratorOptions {
  if (typeof options !== 'object' || options === null) {
    throw new InvalidInputError(
      'options must be { integrator, integratorFeeBps }',
    );
  }
  const { integrator, integratorFeeBps } = options as Record<string, unknown>;
  const address = checkAddress(integrator, 'integrator');
  const feeBps = checkBps(
    integratorFeeBps,
    'integratorFeeBps',
    MAX_INTEGRATOR_FEE_BPS,
  );
  // Fees paid to the contract itself would be held with no record.
  if (address === contractId) {
    throw new InvalidInputError(
      'integrator must not be the contract itself (InvalidIntegrator)',
    );
  }
  return { integrator: address, integratorFeeBps: feeBps };
}
