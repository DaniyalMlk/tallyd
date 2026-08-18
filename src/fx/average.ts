/**
 * Average rates over a period.
 *
 * Translating a profit and loss account needs a rate for a period rather than
 * a date: revenue earned across March was not all earned at the 31 March close.
 * The standard answer is "the average rate for the period", which turns out to
 * mean two different things depending on who is asking.
 *
 * - `quotedAverage` averages the quotes that were actually published. It is
 *   what a rate provider means by an average, and it under-weights the days a
 *   market was shut.
 * - `dailyAverage` averages one rate per calendar day, carrying the last close
 *   forward over weekends. It weights a long bank holiday the way the calendar
 *   does, which is what a monthly P&L translation wants.
 *
 * Both are computed as exact rationals — a mean of fractions summed over a
 * common denominator, never a running float — so a year of daily rates
 * averages to the same value regardless of the order they arrive in.
 */

import type { Currency } from "../money/currency.js";
import {
  type CalendarDate,
  type DateRange,
  addDays,
  compareDates,
  dateRange,
  daysBetween,
  withinRange,
} from "../ledger/date.js";
import { ExchangeRate, RateError } from "./rate.js";
import { NoRateError, type RateTable } from "./table.js";

export type AverageMethod = "quoted" | "daily";

export interface AverageRate {
  readonly rate: ExchangeRate;
  readonly method: AverageMethod;
  readonly range: DateRange;
  /** How many rates went into the mean. */
  readonly observations: number;
  /** The dates that contributed, oldest first. */
  readonly dates: readonly CalendarDate[];
  readonly lowest: ExchangeRate;
  readonly highest: ExchangeRate;
}

export interface AverageOptions {
  /**
   * Days with no usable rate are skipped rather than fatal. Off by default: a
   * gap in the middle of a period is usually a broken rate file, and quietly
   * averaging the days that survived hides it.
   */
  skipMissing?: boolean;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/** The exact mean of a list of rates for one pair. */
export function meanOfRates(rates: readonly ExchangeRate[]): ExchangeRate {
  const first = rates[0];
  if (first === undefined) throw new RateError("Cannot average an empty list of rates");

  let numerator = 0n;
  let denominator = 1n;
  for (const r of rates) {
    if (r.base.code !== first.base.code || r.quote.code !== first.quote.code) {
      throw new RateError(`Cannot average ${first.pair} with ${r.pair}`);
    }
    // n/d + a/b = (n*b + a*d) / (d*b), reduced each step so a year of daily
    // quotes does not grow a denominator with a thousand digits in it.
    numerator = numerator * r.denominator + r.numerator * denominator;
    denominator *= r.denominator;
    const g = gcd(numerator, denominator);
    if (g > 1n) {
      numerator /= g;
      denominator /= g;
    }
  }
  return ExchangeRate.ofRatio(
    numerator,
    denominator * BigInt(rates.length),
    first.base,
    first.quote,
  );
}

function summarise(
  rates: readonly ExchangeRate[],
  dates: readonly CalendarDate[],
  method: AverageMethod,
  range: DateRange,
): AverageRate {
  let lowest = rates[0] as ExchangeRate;
  let highest = rates[0] as ExchangeRate;
  for (const r of rates) {
    if (r.compare(lowest) < 0) lowest = r;
    if (r.compare(highest) > 0) highest = r;
  }
  return Object.freeze({
    rate: meanOfRates(rates),
    method,
    range,
    observations: rates.length,
    dates: Object.freeze([...dates]),
    lowest,
    highest,
  });
}

/**
 * The mean of the rates the table can quote on the days it holds quotes for.
 *
 * "Days it holds quotes for" is the union of every quote date in the table
 * within the range, from any pair — a day the euro was quoted is a day this
 * pair had a price, even if the price came through a triangulation.
 */
export function quotedAverage(
  table: RateTable,
  base: Currency | string,
  quote: Currency | string,
  range: DateRange,
  options: AverageOptions = {},
): AverageRate {
  const candidates = [...new Set(table.all().map((q) => q.date))]
    .filter((d) => withinRange(d, range))
    .sort(compareDates);

  const rates: ExchangeRate[] = [];
  const dates: CalendarDate[] = [];
  for (const day of candidates) {
    try {
      rates.push(table.rateAt(base, quote, day));
      dates.push(day);
    } catch (error) {
      if (options.skipMissing !== true && error instanceof NoRateError) throw error;
      if (!(error instanceof NoRateError)) throw error;
    }
  }

  if (rates.length === 0) {
    throw new NoRateError(
      typeof base === "string" ? base.toUpperCase() : base.code,
      typeof quote === "string" ? quote.toUpperCase() : quote.code,
      range.to,
      `no quotes between ${range.from} and ${range.to}`,
    );
  }
  return summarise(rates, dates, "quoted", range);
}

/**
 * The mean of one rate per calendar day, weekends and holidays carrying the
 * previous close forward through the table's on-or-before rule.
 */
export function dailyAverage(
  table: RateTable,
  base: Currency | string,
  quote: Currency | string,
  range: DateRange,
  options: AverageOptions = {},
): AverageRate {
  const span = daysBetween(range.from, range.to);
  if (span < 0) throw new RateError(`Range ends before it starts: ${range.from}..${range.to}`);

  const rates: ExchangeRate[] = [];
  const dates: CalendarDate[] = [];
  for (let offset = 0; offset <= span; offset++) {
    const day = addDays(range.from, offset);
    try {
      rates.push(table.rateAt(base, quote, day));
      dates.push(day);
    } catch (error) {
      if (!(error instanceof NoRateError)) throw error;
      if (options.skipMissing !== true) throw error;
    }
  }

  if (rates.length === 0) {
    throw new NoRateError(
      typeof base === "string" ? base.toUpperCase() : base.code,
      typeof quote === "string" ? quote.toUpperCase() : quote.code,
      range.to,
      `no usable rate on any day between ${range.from} and ${range.to}`,
    );
  }
  return summarise(rates, dates, "daily", range);
}

/** Either method, chosen by name. */
export function averageRate(
  table: RateTable,
  base: Currency | string,
  quote: Currency | string,
  from: string,
  to: string,
  method: AverageMethod = "daily",
  options: AverageOptions = {},
): AverageRate {
  const range = dateRange(from, to);
  return method === "daily"
    ? dailyAverage(table, base, quote, range, options)
    : quotedAverage(table, base, quote, range, options);
}
