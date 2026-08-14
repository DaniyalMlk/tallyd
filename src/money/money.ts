/**
 * `Money` — an exact amount in a single currency.
 *
 * The amount is a bigint count of minor units (pence, cents, yen). There is no
 * float anywhere in this file and no way to construct a `Money` from one
 * without going through an explicit, rounded conversion.
 *
 * Binary operations between different currencies throw. That is deliberate:
 * a silent currency mix-up is the kind of bug that reconciles to zero and is
 * wrong by thousands.
 */

import {
  type Currency,
  currency as lookupCurrency,
  minorUnitScale,
} from "./currency.js";
import {
  type RoundingMode,
  decimalToRational,
  divideRound,
  numberToRational,
} from "./rounding.js";

export class CurrencyMismatchError extends Error {
  constructor(
    readonly left: Currency,
    readonly right: Currency,
  ) {
    super(`Currency mismatch: ${left.code} and ${right.code}`);
    this.name = "CurrencyMismatchError";
  }
}

export class Money {
  /** Signed count of minor units. */
  readonly minorUnits: bigint;
  readonly currency: Currency;

  private constructor(minorUnits: bigint, currency: Currency) {
    this.minorUnits = minorUnits;
    this.currency = currency;
    Object.freeze(this);
  }

  // ---------------------------------------------------------------- factories

  /** Construct directly from minor units: `Money.ofMinor(1250n, GBP)` is £12.50. */
  static ofMinor(minorUnits: bigint | number, currency: Currency | string): Money {
    const c = typeof currency === "string" ? lookupCurrency(currency) : currency;
    if (typeof minorUnits === "number") {
      if (!Number.isSafeInteger(minorUnits)) {
        throw new RangeError(`Minor units must be a safe integer, got: ${minorUnits}`);
      }
      return new Money(BigInt(minorUnits), c);
    }
    return new Money(minorUnits, c);
  }

  /**
   * Parse a decimal string in major units: `Money.parse("12.50", GBP)`.
   *
   * Extra precision is an error rather than a silent rounding, because a
   * statement line reading `1.005` means the importer misread the file.
   * Pass a rounding mode to opt into truncation explicitly.
   */
  static parse(
    text: string,
    currency: Currency | string,
    rounding?: RoundingMode,
  ): Money {
    const c = typeof currency === "string" ? lookupCurrency(currency) : currency;
    const cleaned = text.trim().replace(/,/g, "");
    const { numerator, denominator } = decimalToRational(cleaned);
    const scale = minorUnitScale(c);
    const scaledNumerator = numerator * scale;
    if (rounding === undefined && scaledNumerator % denominator !== 0n) {
      throw new RangeError(
        `${text} has more precision than ${c.code} allows (${c.exponent} dp)`,
      );
    }
    return new Money(divideRound(scaledNumerator, denominator, rounding ?? "half-even"), c);
  }

  /** Zero in the given currency. */
  static zero(currency: Currency | string): Money {
    return Money.ofMinor(0n, currency);
  }

  /**
   * Convert from a JS number of major units. Lossy by nature, so the rounding
   * mode is required at the call site — no defaults to hide behind.
   */
  static fromNumber(
    value: number,
    currency: Currency | string,
    rounding: RoundingMode,
  ): Money {
    const c = typeof currency === "string" ? lookupCurrency(currency) : currency;
    const { numerator, denominator } = numberToRational(value);
    return new Money(divideRound(numerator * minorUnitScale(c), denominator, rounding), c);
  }

  // --------------------------------------------------------------- predicates

  get isZero(): boolean {
    return this.minorUnits === 0n;
  }

  get isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  get isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  get sign(): -1 | 0 | 1 {
    if (this.minorUnits > 0n) return 1;
    if (this.minorUnits < 0n) return -1;
    return 0;
  }

  sameCurrency(other: Money): boolean {
    return this.currency.code === other.currency.code;
  }

  private assertSameCurrency(other: Money): void {
    if (!this.sameCurrency(other)) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  // --------------------------------------------------------------- arithmetic

  plus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  minus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negated(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  abs(): Money {
    return this.minorUnits < 0n ? this.negated() : this;
  }

  /** Multiply by a whole number. Always exact — no rounding mode needed. */
  timesInteger(factor: bigint | number): Money {
    const f = typeof factor === "number" ? BigInt(assertSafeInteger(factor)) : factor;
    return new Money(this.minorUnits * f, this.currency);
  }

  /**
   * Multiply by an arbitrary factor — a rate, a percentage, a decimal string.
   * Rounds to whole minor units using the given mode (banker's by default).
   */
  times(factor: number | string | bigint, rounding: RoundingMode = "half-even"): Money {
    if (typeof factor === "bigint") return this.timesInteger(factor);
    const { numerator, denominator } =
      typeof factor === "number" ? numberToRational(factor) : decimalToRational(factor);
    return new Money(
      divideRound(this.minorUnits * numerator, denominator, rounding),
      this.currency,
    );
  }

  /** Divide by a number, rounding to whole minor units. */
  dividedBy(divisor: number | string | bigint, rounding: RoundingMode = "half-even"): Money {
    const { numerator, denominator } =
      typeof divisor === "bigint"
        ? { numerator: divisor, denominator: 1n }
        : typeof divisor === "number"
          ? numberToRational(divisor)
          : decimalToRational(divisor);
    if (numerator === 0n) throw new RangeError("Division by zero");
    return new Money(
      divideRound(this.minorUnits * denominator, numerator, rounding),
      this.currency,
    );
  }

  /** The ratio of two amounts as a plain number. Presentation only. */
  ratioTo(other: Money): number {
    this.assertSameCurrency(other);
    if (other.minorUnits === 0n) throw new RangeError("Division by zero");
    return Number(this.minorUnits) / Number(other.minorUnits);
  }

  // ---------------------------------------------------------------- splitting

  /**
   * Split into `n` parts that sum exactly back to the original.
   *
   * The remainder is handed out one minor unit at a time from the front, so
   * £100 / 3 gives 33.34, 33.33, 33.33. Negative amounts distribute the
   * remainder the same way, keeping `split(n).reduce(add) === original`.
   */
  split(parts: number): Money[] {
    if (!Number.isSafeInteger(parts) || parts <= 0) {
      throw new RangeError(`Split count must be a positive integer, got: ${parts}`);
    }
    const n = BigInt(parts);
    const base = this.minorUnits / n; // bigint division truncates toward zero
    let remainder = this.minorUnits - base * n;
    const step = remainder < 0n ? -1n : 1n;

    const out: Money[] = [];
    for (let i = 0n; i < n; i++) {
      let share = base;
      if (remainder !== 0n) {
        share += step;
        remainder -= step;
      }
      out.push(new Money(share, this.currency));
    }
    return out;
  }

  /**
   * Split in proportion to `weights` using the largest-remainder method.
   *
   * Every unit is accounted for: the parts always sum to the original. Where
   * two candidates have the same remainder the earlier one wins, which makes
   * the result deterministic rather than merely correct in aggregate.
   */
  allocate(weights: readonly (number | bigint)[]): Money[] {
    if (weights.length === 0) throw new RangeError("Allocation needs at least one weight");

    const w = weights.map((x) => (typeof x === "bigint" ? x : BigInt(assertSafeInteger(x))));
    if (w.some((x) => x < 0n)) throw new RangeError("Allocation weights must be non-negative");

    const total = w.reduce((a, b) => a + b, 0n);
    if (total === 0n) throw new RangeError("Allocation weights must not all be zero");

    const negative = this.minorUnits < 0n;
    const magnitude = negative ? -this.minorUnits : this.minorUnits;

    const shares = w.map((weight) => (magnitude * weight) / total);
    const remainders = w.map((weight, i) => {
      const share = shares[i] as bigint;
      return { index: i, remainder: magnitude * weight - share * total };
    });

    let leftover = magnitude - shares.reduce((a, b) => a + b, 0n);
    remainders.sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
    for (const entry of remainders) {
      if (leftover <= 0n) break;
      shares[entry.index] = (shares[entry.index] as bigint) + 1n;
      leftover -= 1n;
    }

    return shares.map((s) => new Money(negative ? -s : s, this.currency));
  }

  // -------------------------------------------------------------- comparisons

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.minorUnits > other.minorUnits) return 1;
    if (this.minorUnits < other.minorUnits) return -1;
    return 0;
  }

  equals(other: Money): boolean {
    return this.sameCurrency(other) && this.minorUnits === other.minorUnits;
  }

  greaterThan(other: Money): boolean {
    return this.compare(other) > 0;
  }

  greaterThanOrEqual(other: Money): boolean {
    return this.compare(other) >= 0;
  }

  lessThan(other: Money): boolean {
    return this.compare(other) < 0;
  }

  lessThanOrEqual(other: Money): boolean {
    return this.compare(other) <= 0;
  }

  /** True when the two differ by no more than `tolerance` (which must be >= 0). */
  within(other: Money, tolerance: Money): boolean {
    this.assertSameCurrency(other);
    this.assertSameCurrency(tolerance);
    if (tolerance.isNegative) throw new RangeError("Tolerance must be non-negative");
    return this.minus(other).abs().lessThanOrEqual(tolerance);
  }

  // ------------------------------------------------------------- presentation

  /** The amount as a decimal string in major units, e.g. "-12.50". */
  toDecimalString(): string {
    const scale = minorUnitScale(this.currency);
    const negative = this.minorUnits < 0n;
    const magnitude = negative ? -this.minorUnits : this.minorUnits;
    const whole = magnitude / scale;
    const sign = negative ? "-" : "";
    if (this.currency.exponent === 0) return `${sign}${whole}`;
    const fraction = (magnitude % scale).toString().padStart(this.currency.exponent, "0");
    return `${sign}${whole}.${fraction}`;
  }

  /** Human-facing form with symbol and thousands separators: "£1,234.50". */
  format(options: { symbol?: boolean; grouping?: boolean } = {}): string {
    const { symbol = true, grouping = true } = options;
    const decimal = this.toDecimalString();
    const negative = decimal.startsWith("-");
    const body = negative ? decimal.slice(1) : decimal;
    const dot = body.indexOf(".");
    let whole = dot === -1 ? body : body.slice(0, dot);
    const fraction = dot === -1 ? "" : body.slice(dot);
    if (grouping) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const prefix = symbol ? this.currency.symbol : "";
    return `${negative ? "-" : ""}${prefix}${whole}${fraction}`;
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.currency.code}`;
  }

  toJSON(): { amount: string; currency: string } {
    return { amount: this.minorUnits.toString(), currency: this.currency.code };
  }

  static fromJSON(value: { amount: string; currency: string }): Money {
    return Money.ofMinor(BigInt(value.amount), lookupCurrency(value.currency));
  }
}

function assertSafeInteger(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Expected a safe integer, got: ${value}`);
  }
  return value;
}

/** Sum a list of amounts. Requires the currency when the list may be empty. */
export function sumMoney(
  amounts: readonly Money[],
  currency?: Currency | string,
): Money {
  const first = amounts[0];
  if (first === undefined) {
    if (currency === undefined) {
      throw new RangeError("Cannot sum an empty list without an explicit currency");
    }
    return Money.zero(currency);
  }
  return amounts.reduce((a, b) => a.plus(b), Money.zero(currency ?? first.currency));
}

export function minMoney(a: Money, b: Money): Money {
  return a.lessThanOrEqual(b) ? a : b;
}

export function maxMoney(a: Money, b: Money): Money {
  return a.greaterThanOrEqual(b) ? a : b;
}
