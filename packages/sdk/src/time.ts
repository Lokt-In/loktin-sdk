import { InvalidInputError } from './errors.js';
import { checkDate } from './validate.js';

/** A half-open span of time: from `start` up to, but not including, `end`. */
export interface TimeWindow {
  readonly start: Date;
  /** The first second after the window. */
  readonly end: Date;
}

/** Options for {@link windowInTimeZone}. */
export interface TimeZoneOptions {
  /** An IANA time zone such as `Europe/London`. Defaults to the device's zone. */
  readonly timeZone?: string | undefined;
  /** A BCP 47 locale such as `en-GB`. Defaults to the device's locale. */
  readonly locale?: string | undefined;
}

/** A window formatted for display. */
export interface FormattedWindow {
  readonly start: string;
  /** The first moment after the window, formatted the same way. */
  readonly end: string;
  /** The time zone used. */
  readonly timeZone: string;
}

/**
 * Formats a window, such as a Spend & Save withdrawal window, in a time zone
 * with `Intl.DateTimeFormat` (K11). It uses the runtime's time zone data, and
 * the SDK bundles none.
 */
export function windowInTimeZone(
  window: TimeWindow,
  options: TimeZoneOptions = {},
): FormattedWindow {
  const start = checkDate(window.start, 'window.start');
  const end = checkDate(window.end, 'window.end');
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat(options.locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    });
  } catch (error) {
    throw new InvalidInputError(
      'timeZone or locale is not one the runtime knows',
      { cause: error },
    );
  }
  return {
    start: format.format(start),
    end: format.format(end),
    timeZone: format.resolvedOptions().timeZone,
  };
}
