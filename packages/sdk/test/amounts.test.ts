import { describe, expect, it } from 'vitest';
import { InvalidInputError, fromBaseUnits, toBaseUnits } from '../src/index.js';

const I128_MAX = 2n ** 127n - 1n;
const I128_MIN = -(2n ** 127n);

describe('toBaseUnits', () => {
  it('converts plain decimals with 7 decimals by default', () => {
    expect(toBaseUnits('12.5')).toBe(125_000_000n);
    expect(toBaseUnits('1')).toBe(10_000_000n);
    expect(toBaseUnits('0')).toBe(0n);
    expect(toBaseUnits('0.0000001')).toBe(1n);
    expect(toBaseUnits('007.10')).toBe(71_000_000n);
    expect(toBaseUnits('-2.5')).toBe(-25_000_000n);
  });

  it('accepts exactly the allowed number of decimal places', () => {
    expect(toBaseUnits('1.1234567')).toBe(11_234_567n);
    expect(toBaseUnits('1.25', 2)).toBe(125n);
    expect(toBaseUnits('42', 0)).toBe(42n);
  });

  it('accepts the i128 boundaries', () => {
    expect(toBaseUnits(I128_MAX.toString(), 0)).toBe(I128_MAX);
    expect(toBaseUnits(I128_MIN.toString(), 0)).toBe(I128_MIN);
    expect(toBaseUnits('17014118346046923173168730371588.4105727')).toBe(
      I128_MAX,
    );
  });

  it('rejects values outside i128', () => {
    expect(() => toBaseUnits((I128_MAX + 1n).toString(), 0)).toThrow(
      InvalidInputError,
    );
    expect(() => toBaseUnits((I128_MIN - 1n).toString(), 0)).toThrow(
      InvalidInputError,
    );
    expect(() =>
      toBaseUnits('17014118346046923173168730371588.4105728'),
    ).toThrow(InvalidInputError);
  });

  it('rejects more decimal places than allowed', () => {
    expect(() => toBaseUnits('1.12345678')).toThrow(
      /more than 7 decimal places/,
    );
    expect(() => toBaseUnits('1.5', 0)).toThrow(InvalidInputError);
  });

  it('rejects numbers', () => {
    expect(() => toBaseUnits(12.5 as unknown as string)).toThrow(
      /not a number/,
    );
    expect(() => toBaseUnits(1 as unknown as string)).toThrow(
      InvalidInputError,
    );
    expect(() => toBaseUnits(10n as unknown as string)).toThrow(
      InvalidInputError,
    );
  });

  it.each([
    '1e7',
    '1E-7',
    '',
    ' 1',
    '1 ',
    '+1',
    '.5',
    '5.',
    '1,000',
    '1_000',
    '0x10',
    'NaN',
    'Infinity',
    '1.2.3',
    '--1',
    '١',
  ])('rejects %j, which is not a plain decimal', (value) => {
    expect(() => toBaseUnits(value)).toThrow(InvalidInputError);
  });

  it('rejects invalid decimals', () => {
    for (const decimals of [-1, 1.5, 39, Number.NaN]) {
      expect(() => toBaseUnits('1', decimals)).toThrow(/decimals/);
    }
  });

  it('throws errors with the INVALID_INPUT code', () => {
    expect(() => toBaseUnits('abc')).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });
});

describe('fromBaseUnits', () => {
  it('converts base units to decimals without trailing zeros', () => {
    expect(fromBaseUnits(125_000_000n)).toBe('12.5');
    expect(fromBaseUnits(10_000_000n)).toBe('1');
    expect(fromBaseUnits(0n)).toBe('0');
    expect(fromBaseUnits(1n)).toBe('0.0000001');
    expect(fromBaseUnits(-25_000_000n)).toBe('-2.5');
    expect(fromBaseUnits(125n, 2)).toBe('1.25');
    expect(fromBaseUnits(42n, 0)).toBe('42');
  });

  it('handles the i128 boundaries and round-trips them', () => {
    expect(fromBaseUnits(I128_MAX)).toBe(
      '17014118346046923173168730371588.4105727',
    );
    expect(fromBaseUnits(I128_MIN)).toBe(
      '-17014118346046923173168730371588.4105728',
    );
    for (const units of [I128_MAX, I128_MIN, 1n, -1n, 0n, 99_999_999n]) {
      expect(toBaseUnits(fromBaseUnits(units))).toBe(units);
    }
  });

  it('rejects values outside i128', () => {
    expect(() => fromBaseUnits(I128_MAX + 1n)).toThrow(InvalidInputError);
    expect(() => fromBaseUnits(I128_MIN - 1n)).toThrow(InvalidInputError);
  });

  it('rejects numbers and strings', () => {
    expect(() => fromBaseUnits(125 as unknown as bigint)).toThrow(/bigint/);
    expect(() => fromBaseUnits('125' as unknown as bigint)).toThrow(
      InvalidInputError,
    );
  });

  it('rejects invalid decimals', () => {
    expect(() => fromBaseUnits(1n, -1)).toThrow(/decimals/);
    expect(() => fromBaseUnits(1n, 2.5)).toThrow(/decimals/);
  });
});
