import { InvalidInputError } from './errors.js';

// Contract amounts are i128.
const I128_MIN = -(2n ** 127n);
const I128_MAX = 2n ** 127n - 1n;
const PLAIN_DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

function checkDecimals(decimals: unknown): number {
  if (
    typeof decimals !== 'number' ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 38
  ) {
    throw new InvalidInputError('decimals must be a whole number from 0 to 38');
  }
  return decimals;
}

function checkRange(units: bigint): bigint {
  if (units < I128_MIN || units > I128_MAX) {
    throw new InvalidInputError('the amount does not fit in an i128');
  }
  return units;
}

/**
 * Converts a decimal string, such as "12.5", to base units (K8). USDC on
 * Stellar has 7 decimals, so "12.5" is 125000000n.
 *
 * Only plain decimal strings are accepted: no numbers, exponents, signs other
 * than a leading "-", spaces or separators, and no more decimal places than
 * `decimals`.
 */
export function toBaseUnits(decimal: string, decimals = 7): bigint {
  const places = checkDecimals(decimals);
  if (typeof decimal !== 'string') {
    throw new InvalidInputError(
      'the amount must be a decimal string, not a number',
    );
  }
  const match = PLAIN_DECIMAL.exec(decimal);
  if (match === null) {
    throw new InvalidInputError(`"${decimal}" is not a plain decimal`);
  }
  const [, sign = '', whole = '', fraction = ''] = match;
  if (fraction.length > places) {
    throw new InvalidInputError(
      `"${decimal}" has more than ${String(places)} decimal places`,
    );
  }
  const magnitude =
    BigInt(whole) * 10n ** BigInt(places) +
    BigInt(fraction.padEnd(places, '0') || '0');
  return checkRange(sign === '-' ? -magnitude : magnitude);
}

/**
 * Converts base units to a decimal string (K8), with no trailing zeros:
 * 125000000n with 7 decimals is "12.5".
 */
export function fromBaseUnits(units: bigint, decimals = 7): string {
  const places = checkDecimals(decimals);
  if (typeof units !== 'bigint') {
    throw new InvalidInputError('the amount must be a bigint');
  }
  checkRange(units);
  const sign = units < 0n ? '-' : '';
  const digits = (units < 0n ? -units : units)
    .toString()
    .padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places).replace(/0+$/, '');
  return fraction === '' ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}
