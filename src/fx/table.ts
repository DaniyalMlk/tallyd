/**
 * A table of dated quotes, and the lookup rules that turn it into an answer.
 *
 * Rate files are sparse in three different ways at once, and a lookup has to
 * survive all three:
 *
 * - **Sparse in time.** Rates are published on business days and asked for on
 *   any day. A payment dated Sunday needs Friday's close. So lookup is
 *   on-or-before, with a bound on how stale an answer is allowed to be —
 *   because silently reaching back four hundred days is worse than admitting
 *   there is no rate.
 * - **Sparse in direction.** A file that quotes EUR/GBP can answer GBP/EUR by
 *   inversion, and there is no reason to make the caller notice.
 * - **Sparse in pairs.** A file quoting everything against the euro can answer
 *   USD/GBP by going through it. The search is a breadth-first walk over the
 *   pairs quoted on the effective date, so the answer uses the fewest legs
 *   available, and ties break on currency code so the same table always gives
 *   the same answer.
 *
 * Every path is recorded on the result. A revaluation that went through two
 * legs and a five-day-old quote should be able to say so.
 */

import type { Currency } from "../money/currency.js";
import { currency as lookupCurrency } from "../money/currency.js";
import type { Money } from "../money/money.js";
import type { RoundingMode } from "../money/rounding.js";
import { type CalendarDate, compareDates, date as parseDate, daysBetween } from "../ledger/date.js";
import { ExchangeRate, RateError } from "./rate.js";

export class NoRateError extends RateError {
  constructor(
    readonly base: string,
    readonly quote: string,
    readonly asAt: CalendarDate,
    detail: string,
  ) {
    super(`No ${base}/${quote} rate available on ${asAt}: ${detail}`);
    this.name = "NoRateError";
  }
}

/** One published quote. */
export interface Quote {
  readonly date: CalendarDate;
  readonly rate: ExchangeRate;
  /** Where it came from — a file name, a central bank, "manual". */
  readonly source: string;
}

export interface QuoteInput {
  date: string;
  base: Currency | string;
  quote: Currency | string;
  /** Decimal literal: how many units of `quote` one unit of `base` buys. */
  rate: string | number;
  source?: string;
}

/** How a rate was arrived at, kept so a report can explain itself. */
export interface RateLookup {
  readonly rate: ExchangeRate;
  /** The dates of the quotes used, in the order they were composed. */
  readonly quoteDates: readonly CalendarDate[];
  /** Currency codes walked through, from base to quote inclusive. */
  readonly via: readonly string[];
  /** Days between the oldest quote used and the date asked for. */
  readonly staleDays: number;
  readonly sources: readonly string[];
  readonly direct: boolean;
}

export interface RateTableOptions {
  /**
   * How many days back a lookup may reach for a quote. Four covers a long
   * weekend with a bank holiday on either side, which is the case that
   * actually bites; the default is deliberately not "forever".
   */
  maxStaleDays?: number;
  /** How many legs a triangulated path may use. Two is a pivot currency. */
  maxLegs?: number;
}

const DEFAULT_MAX_STALE_DAYS = 4;
const DEFAULT_MAX_LEGS = 3;

function code(c: Currency | string): string {
  return (typeof c === "string" ? lookupCurrency(c) : c).code;
}

function pairKey(base: string, quote: string): string {
  return `${base}/${quote}`;
}

export class RateTable {
  /** Quotes for a directed pair, sorted by date ascending. */
  private readonly quotes: ReadonlyMap<string, readonly Quote[]>;
  readonly maxStaleDays: number;
  readonly maxLegs: number;

  private constructor(
    quotes: ReadonlyMap<string, readonly Quote[]>,
    maxStaleDays: number,
    maxLegs: number,
  ) {
    this.quotes = quotes;
    this.maxStaleDays = maxStaleDays;
    this.maxLegs = maxLegs;
    Object.freeze(this);
  }

  static empty(options: RateTableOptions = {}): RateTable {
    return new RateTable(
      new Map(),
      options.maxStaleDays ?? DEFAULT_MAX_STALE_DAYS,
      options.maxLegs ?? DEFAULT_MAX_LEGS,
    );
  }

  static of(inputs: readonly QuoteInput[], options: RateTableOptions = {}): RateTable {
    return RateTable.empty(options).withAll(inputs);
  }

  /**
   * Add a quote, returning a new table. A second quote for the same pair and
   * date replaces the first: rate files get corrected, and the later word wins.
   */
  with(input: QuoteInput): RateTable {
    const when = parseDate(input.date);
    const built = ExchangeRate.of(input.rate, input.base, input.quote);
    const key = pairKey(built.base.code, built.quote.code);
    const existing = this.quotes.get(key) ?? [];
    const quote: Quote = Object.freeze({
      date: when,
      rate: built,
      source: input.source ?? "manual",
    });

    const kept = existing.filter((q) => q.date !== when);
    kept.push(quote);
    kept.sort((a, b) => compareDates(a.date, b.date));

    const next = new Map(this.quotes);
    next.set(key, Object.freeze(kept));
    return new RateTable(next, this.maxStaleDays, this.maxLegs);
  }

  withAll(inputs: readonly QuoteInput[]): RateTable {
    let table: RateTable = this;
    for (const input of inputs) table = table.with(input);
    return table;
  }

  withOptions(options: RateTableOptions): RateTable {
    return new RateTable(
      this.quotes,
      options.maxStaleDays ?? this.maxStaleDays,
      options.maxLegs ?? this.maxLegs,
    );
  }

  // ------------------------------------------------------------------ reading

  get size(): number {
    let total = 0;
    for (const list of this.quotes.values()) total += list.length;
    return total;
  }

  get isEmpty(): boolean {
    return this.size === 0;
  }

  /** Every directed pair with at least one quote, sorted. */
  pairs(): readonly string[] {
    return [...this.quotes.keys()].sort();
  }

  /** Every currency mentioned by any quote, sorted by code. */
  currencies(): readonly string[] {
    const seen = new Set<string>();
    for (const key of this.quotes.keys()) {
      const [base, quote] = key.split("/") as [string, string];
      seen.add(base);
      seen.add(quote);
    }
    return [...seen].sort();
  }

  /** All quotes for a directed pair, oldest first. */
  quotesFor(base: Currency | string, quote: Currency | string): readonly Quote[] {
    return this.quotes.get(pairKey(code(base), code(quote))) ?? [];
  }

  /** Every quote in the table, sorted by date then pair. */
  all(): readonly Quote[] {
    const out: Quote[] = [];
    for (const list of this.quotes.values()) out.push(...list);
    out.sort((a, b) =>
      a.date === b.date ? a.rate.pair.localeCompare(b.rate.pair) : compareDates(a.date, b.date),
    );
    return out;
  }

  /** The most recent quote for a directed pair on or before a date. */
  private directQuote(base: string, quote: string, asAt: CalendarDate): Quote | undefined {
    const list = this.quotes.get(pairKey(base, quote));
    if (list === undefined) return undefined;
    let found: Quote | undefined;
    for (const q of list) {
      if (compareDates(q.date, asAt) > 0) break;
      found = q;
    }
    if (found === undefined) return undefined;
    return daysBetween(found.date, asAt) <= this.maxStaleDays ? found : undefined;
  }

  /**
   * The nearest usable quote for a pair in either direction, already turned
   * the right way round.
   */
  private edge(from: string, to: string, asAt: CalendarDate): Quote | undefined {
    const forward = this.directQuote(from, to, asAt);
    const backward = this.directQuote(to, from, asAt);
    if (forward === undefined) {
      if (backward === undefined) return undefined;
      return Object.freeze({
        date: backward.date,
        rate: backward.rate.inverse(),
        source: backward.source,
      });
    }
    if (backward === undefined) return forward;
    // Both directions are quoted. Prefer the fresher one; on a tie, the
    // forward quote, so the answer does not depend on map ordering.
    return compareDates(backward.date, forward.date) > 0
      ? Object.freeze({
          date: backward.date,
          rate: backward.rate.inverse(),
          source: backward.source,
        })
      : forward;
  }

  /**
   * Currencies quoted against `from` somewhere in the table, sorted so the
   * walk is deterministic. Whether a usable quote exists on the date asked
   * about is `edge`'s question, not this one's.
   */
  private neighbours(from: string): readonly string[] {
    const out = new Set<string>();
    for (const key of this.quotes.keys()) {
      const [a, b] = key.split("/") as [string, string];
      if (a === from) out.add(b);
      else if (b === from) out.add(a);
    }
    return [...out].sort();
  }

  /**
   * Find a rate, explaining how. Direct first, then inverted, then the shortest
   * chain of quoted pairs.
   */
  lookup(
    base: Currency | string,
    quote: Currency | string,
    asAt: string,
  ): RateLookup {
    const from = code(base);
    const to = code(quote);
    const when = parseDate(asAt);

    if (from === to) {
      throw new RateError(`A rate needs two different currencies, got ${from} twice`);
    }
    if (this.isEmpty) {
      throw new NoRateError(from, to, when, "the table is empty");
    }

    // Breadth-first over currencies, so the path with the fewest legs wins and
    // ties break on the sorted neighbour order.
    interface Step {
      readonly currency: string;
      readonly rate: ExchangeRate | null;
      readonly dates: readonly CalendarDate[];
      readonly via: readonly string[];
      readonly sources: readonly string[];
    }

    const start: Step = { currency: from, rate: null, dates: [], via: [from], sources: [] };
    const queue: Step[] = [start];
    const seen = new Set<string>([from]);

    while (queue.length > 0) {
      const step = queue.shift() as Step;
      if (step.via.length > this.maxLegs) continue;
      for (const next of this.neighbours(step.currency)) {
        if (seen.has(next)) continue;
        const hop = this.edge(step.currency, next, when);
        if (hop === undefined) continue;
        const combined = step.rate === null ? hop.rate : step.rate.then(hop.rate);
        const built: Step = {
          currency: next,
          rate: combined,
          dates: [...step.dates, hop.date],
          via: [...step.via, next],
          sources: [...step.sources, hop.source],
        };
        if (next === to) {
          const staleDays = Math.max(...built.dates.map((d) => daysBetween(d, when)));
          return Object.freeze({
            rate: combined,
            quoteDates: Object.freeze(built.dates),
            via: Object.freeze(built.via),
            staleDays,
            sources: Object.freeze([...new Set(built.sources)]),
            direct: built.via.length === 2,
          });
        }
        if (built.via.length < this.maxLegs + 1) {
          seen.add(next);
          queue.push(built);
        }
      }
    }

    const anyQuote = this.quotes.get(pairKey(from, to)) ?? this.quotes.get(pairKey(to, from));
    if (anyQuote !== undefined && anyQuote.length > 0) {
      const newest = anyQuote[anyQuote.length - 1] as Quote;
      const gap = daysBetween(newest.date, when);
      const detail =
        gap < 0
          ? `the earliest quote is ${newest.date}, after the date asked for`
          : `the nearest quote is ${newest.date}, ${gap} days stale (limit ${this.maxStaleDays})`;
      throw new NoRateError(from, to, when, detail);
    }
    throw new NoRateError(
      from,
      to,
      when,
      `no path through the quoted currencies (${this.currencies().join(", ")})`,
    );
  }

  /** Just the rate, for callers that do not need the provenance. */
  rateAt(base: Currency | string, quote: Currency | string, asAt: string): ExchangeRate {
    return this.lookup(base, quote, asAt).rate;
  }

  /** True when a lookup would succeed. */
  has(base: Currency | string, quote: Currency | string, asAt: string): boolean {
    try {
      this.lookup(base, quote, asAt);
      return true;
    } catch {
      return false;
    }
  }

  /** Convert an amount into `target` using the rate in force on `asAt`. */
  convert(
    amount: Money,
    target: Currency | string,
    asAt: string,
    rounding: RoundingMode = "half-even",
  ): Money {
    if (amount.currency.code === code(target)) return amount;
    return this.lookup(amount.currency, target, asAt).rate.convert(amount, rounding);
  }
}
