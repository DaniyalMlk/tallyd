/**
 * An exchange rate as an exact rational.
 *
 * A rate is a price: one unit of the base currency costs `numerator/denominator`
 * units of the quote currency. Holding that as a pair of bigints rather than a
 * float matters for the same reason `Money` holds minor units — a rate arrives
 * as a decimal string from a file, gets inverted, gets composed with another
 * rate, and only at the very end multiplies an amount. Every one of those steps
 * on a float loses a little, and the losses land in a revaluation entry where
 * they look like a real gain.
 *
 * So: parse once into a rational, do all the algebra exactly, and round exactly
 * once, at the point where a `Money` has to come out.
 */

import type { Currency } from "../money/currency.js";
import { currency as lookupCurrency } from "../money/currency.js";
import { Money } from "../money/money.js";
import { type RoundingMode, decimalToRational, divideRound } from "../money/rounding.js";

export class RateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateError";
  }
}

/** Greatest common divisor of two non-negative bigints. */
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

function resolve(c: Currency | string): Currency {
  return typeof c === "string" ? lookupCurrency(c) : c;
}

export class ExchangeRate {
  /** One unit of `base` buys `numerator / denominator` units of `quote`. */
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly base: Currency;
  readonly quote: Currency;

  private constructor(
    numerator: bigint,
    denominator: bigint,
    base: Currency,
    quote: Currency,
  ) {
    this.numerator = numerator;
    this.denominator = denominator;
    this.base = base;
    this.quote = quote;
    Object.freeze(this);
  }

  // ---------------------------------------------------------------- factories

  /**
   * Build from an exact ratio. The pair is normalised so the denominator is
   * positive and the fraction is in lowest terms, which makes `equals` a
   * component comparison rather than a cross-multiplication.
   */
  static ofRatio(
    numerator: bigint,
    denominator: bigint,
    base: Currency | string,
    quote: Currency | string,
  ): ExchangeRate {
    if (denominator === 0n) throw new RateError("Rate denominator must not be zero");
    let n = numerator;
    let d = denominator;
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    if (n <= 0n) {
      throw new RateError(`Rate must be positive, got ${numerator}/${denominator}`);
    }
    const g = gcd(n, d);
    const b = resolve(base);
    const q = resolve(quote);
    if (b.code === q.code) {
      throw new RateError(`A rate needs two different currencies, got ${b.code} twice`);
    }
    return new ExchangeRate(n / g, d / g, b, q);
  }

  /** Build from a decimal literal: `ExchangeRate.of("0.8473", "EUR", "GBP")`. */
  static of(
    value: string | number,
    base: Currency | string,
    quote: Currency | string,
  ): ExchangeRate {
    const text = typeof value === "number" ? value.toString() : value;
    let parsed: { numerator: bigint; denominator: bigint };
    try {
      parsed = decimalToRational(text);
    } catch {
      throw new RateError(`Not a rate: ${JSON.stringify(text)}`);
    }
    return ExchangeRate.ofRatio(parsed.numerator, parsed.denominator, base, quote);
  }

  /**
   * The rate implied by two amounts that are the same value in two currencies.
   *
   * This is how a rate is recovered from a posting that already carries both
   * sides: the foreign amount and its functional-currency equivalent imply the
   * rate that was used, to whatever precision the two amounts pin down.
   */
  static implied(from: Money, to: Money): ExchangeRate {
    if (from.isZero) throw new RateError("Cannot imply a rate from a zero amount");
    if (to.isZero) throw new RateError("Cannot imply a rate to a zero amount");
    if (from.sign !== to.sign) {
      throw new RateError(
        `Cannot imply a rate between ${from.toString()} and ${to.toString()}: opposite signs`,
      );
    }
    // minor(to) / 10^e(to) divided by minor(from) / 10^e(from).
    const scaleFrom = 10n ** BigInt(from.currency.exponent);
    const scaleTo = 10n ** BigInt(to.currency.exponent);
    return ExchangeRate.ofRatio(
      to.minorUnits * scaleFrom,
      from.minorUnits * scaleTo,
      from.currency,
      to.currency,
    );
  }

  // --------------------------------------------------------------- the algebra

  /** The same price read the other way round: GBP per EUR becomes EUR per GBP. */
  inverse(): ExchangeRate {
    return ExchangeRate.ofRatio(this.denominator, this.numerator, this.quote, this.base);
  }

  /**
   * Compose with a rate that starts where this one ends: EUR->USD then USD->GBP
   * gives EUR->GBP, exactly, with no intermediate rounding.
   */
  then(next: ExchangeRate): ExchangeRate {
    if (this.quote.code !== next.base.code) {
      throw new RateError(
        `Cannot chain ${this.pair} with ${next.pair}: ${this.quote.code} is not ${next.base.code}`,
      );
    }
    return ExchangeRate.ofRatio(
      this.numerator * next.numerator,
      this.denominator * next.denominator,
      this.base,
      next.quote,
    );
  }

  /** True when the two describe the same price of the same pair. */
  equals(other: ExchangeRate): boolean {
    return (
      this.base.code === other.base.code &&
      this.quote.code === other.quote.code &&
      this.numerator === other.numerator &&
      this.denominator === other.denominator
    );
  }

  /** Order by price. Both must quote the same pair. */
  compare(other: ExchangeRate): -1 | 0 | 1 {
    if (this.base.code !== other.base.code || this.quote.code !== other.quote.code) {
      throw new RateError(`Cannot compare ${this.pair} with ${other.pair}`);
    }
    const left = this.numerator * other.denominator;
    const right = other.numerator * this.denominator;
    if (left > right) return 1;
    if (left < right) return -1;
    return 0;
  }

  // --------------------------------------------------------------- conversion

  /**
   * Convert an amount in the base currency into the quote currency.
   *
   * The whole calculation is one bigint division, so an amount converted at a
   * composed rate rounds once rather than once per leg.
   */
  convert(amount: Money, rounding: RoundingMode = "half-even"): Money {
    if (amount.currency.code !== this.base.code) {
      throw new RateError(
        `Cannot convert ${amount.currency.code} at a ${this.pair} rate`,
      );
    }
    const scaleFrom = 10n ** BigInt(this.base.exponent);
    const scaleTo = 10n ** BigInt(this.quote.exponent);
    const value = divideRound(
      amount.minorUnits * this.numerator * scaleTo,
      this.denominator * scaleFrom,
      rounding,
    );
    return Money.ofMinor(value, this.quote);
  }

  /** Convert in whichever direction the amount's currency calls for. */
  apply(amount: Money, rounding: RoundingMode = "half-even"): Money {
    if (amount.currency.code === this.base.code) return this.convert(amount, rounding);
    if (amount.currency.code === this.quote.code) {
      return this.inverse().convert(amount, rounding);
    }
    throw new RateError(`${amount.currency.code} is not part of ${this.pair}`);
  }

  // ------------------------------------------------------------- presentation

  get pair(): string {
    return `${this.base.code}/${this.quote.code}`;
  }

  /** The price as a decimal string with `places` digits, rounded half-even. */
  toDecimalString(places = 6): string {
    if (!Number.isInteger(places) || places < 0 || places > 20) {
      throw new RateError(`Rate precision must be an integer in 0..20, got ${places}`);
    }
    const scale = 10n ** BigInt(places);
    const scaled = divideRound(this.numerator * scale, this.denominator, "half-even");
    const whole = scaled / scale;
    if (places === 0) return whole.toString();
    const fraction = (scaled % scale).toString().padStart(places, "0");
    return `${whole}.${fraction}`;
  }

  /** A float, for charts and log lines. Never for the accounting path. */
  toNumber(): number {
    return Number(this.toDecimalString(12));
  }

  toString(): string {
    return `1 ${this.base.code} = ${this.toDecimalString()} ${this.quote.code}`;
  }

  toJSON(): { base: string; quote: string; rate: string } {
    return { base: this.base.code, quote: this.quote.code, rate: this.toDecimalString(10) };
  }
}

/** Shorthand for `ExchangeRate.of`, for readable fixtures and call sites. */
export function rate(
  value: string | number,
  base: Currency | string,
  quote: Currency | string,
): ExchangeRate {
  return ExchangeRate.of(value, base, quote);
}
