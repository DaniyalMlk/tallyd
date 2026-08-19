/**
 * An ownership interest, exactly.
 *
 * This has to be a rational and not a decimal, because the interests that
 * matter are the ones that come out of a chain. A parent holding two thirds of
 * a company that holds three quarters of a third owns exactly half of the
 * third, and there is no decimal expansion of two thirds to write that with.
 * Rounded to four places and multiplied through, 66.67% of 75% is 50.0025%,
 * which is then multiplied by a number of pounds and shows up in a balance
 * sheet as a non-controlling interest that is out by a few pence in a way
 * nobody can trace.
 *
 * So: a numerator and a denominator over bigints, normalised, never converted
 * to a float except for display, and constrained to [0, 1] because an interest
 * outside that range is not an interest.
 */

import { Money } from "../money/money.js";
import { decimalToRational, divideRound, type RoundingMode } from "../money/rounding.js";

export class InterestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InterestError";
  }
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

export class Interest {
  readonly numerator: bigint;
  readonly denominator: bigint;

  private constructor(numerator: bigint, denominator: bigint) {
    this.numerator = numerator;
    this.denominator = denominator;
    Object.freeze(this);
  }

  // ---------------------------------------------------------------- factories

  /**
   * A fraction, given as a ratio. Normalised on the way in, so `of(2n, 4n)`
   * and `of(1n, 2n)` are the same object by `equals` and print the same.
   */
  static of(numerator: bigint | number, denominator: bigint | number = 1n): Interest {
    let n = BigInt(numerator);
    let d = BigInt(denominator);
    if (d === 0n) throw new InterestError("An interest cannot have a zero denominator");
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    if (n < 0n) throw new InterestError(`An interest cannot be negative: ${n}/${d}`);
    if (n > d) {
      throw new InterestError(
        `An interest cannot exceed the whole: ${n}/${d} is more than 100%`,
      );
    }
    const g = gcd(n, d);
    return new Interest(g === 0n ? 0n : n / g, g === 0n ? 1n : d / g);
  }

  /**
   * From a percentage written as a decimal string or a number. The string form
   * is exact — `ofPercent("33.333")` is 33333/100000 and not the nearest
   * double — and is what a document loader should use.
   */
  static ofPercent(value: string | number): Interest {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new InterestError(`Not a percentage: ${value}`);
      return Interest.ofPercent(String(value));
    }
    const trimmed = value.trim().replace(/%$/, "").trim();
    if (trimmed === "") throw new InterestError("Not a percentage: an empty string");
    let rational: { numerator: bigint; denominator: bigint };
    try {
      rational = decimalToRational(trimmed);
    } catch {
      throw new InterestError(`Not a percentage: ${JSON.stringify(value)}`);
    }
    return Interest.of(rational.numerator, rational.denominator * 100n);
  }

  /** From basis points: 8000 is 80%. */
  static ofBasisPoints(points: bigint | number): Interest {
    return Interest.of(BigInt(points), 10000n);
  }

  static readonly whole: Interest = new Interest(1n, 1n);
  static readonly none: Interest = new Interest(0n, 1n);

  // ------------------------------------------------------------------ algebra

  /**
   * The interest held through this one. A parent's 80% of a subsidiary that
   * itself holds 75% of a third company gives the parent 60% of the third.
   */
  times(other: Interest): Interest {
    return Interest.of(this.numerator * other.numerator, this.denominator * other.denominator);
  }

  /** Two holdings in the same company, added. Throws if they exceed the whole. */
  plus(other: Interest): Interest {
    return Interest.of(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  minus(other: Interest): Interest {
    return Interest.of(
      this.numerator * other.denominator - other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  /** What everybody else holds. The non-controlling interest, when this is the group's. */
  complement(): Interest {
    return Interest.of(this.denominator - this.numerator, this.denominator);
  }

  // ---------------------------------------------------------------- predicates

  get isZero(): boolean {
    return this.numerator === 0n;
  }

  get isWhole(): boolean {
    return this.numerator === this.denominator;
  }

  /**
   * More than half. Control is a question about voting rights and in principle
   * a bare majority is neither necessary nor sufficient for it; this is the
   * arithmetic part of the test and the group structure treats it as a default
   * that a definition can override.
   */
  get isControlling(): boolean {
    return this.numerator * 2n > this.denominator;
  }

  compare(other: Interest): -1 | 0 | 1 {
    const left = this.numerator * other.denominator;
    const right = other.numerator * this.denominator;
    return left < right ? -1 : left > right ? 1 : 0;
  }

  equals(other: Interest): boolean {
    return this.numerator === other.numerator && this.denominator === other.denominator;
  }

  // ------------------------------------------------------------------- money

  /**
   * This share of an amount, rounded to whole minor units.
   *
   * Exact until the last step: the multiplication and the division happen in
   * one bigint operation, so 40% of 3 pence is decided by the rounding mode
   * rather than by an intermediate float.
   */
  share(amount: Money, rounding: RoundingMode = "half-even"): Money {
    return Money.ofMinor(
      divideRound(amount.minorUnits * this.numerator, this.denominator, rounding),
      amount.currency,
    );
  }

  /**
   * This share and the rest, summing exactly back to the amount.
   *
   * `share` on its own cannot promise that: 50% of an odd number of pence
   * rounds one way, its complement rounds the same way, and the two halves
   * come to a penny more or less than the whole. The remainder is given to the
   * other side, so that a group share and a non-controlling interest always
   * add up to what was there.
   */
  splitOf(amount: Money, rounding: RoundingMode = "half-even"): { mine: Money; theirs: Money } {
    const mine = this.share(amount, rounding);
    return { mine, theirs: amount.minus(mine) };
  }

  // ------------------------------------------------------------------ display

  toNumber(): number {
    return Number(this.numerator) / Number(this.denominator);
  }

  /**
   * As a percentage, trailing zeros trimmed. Exact when the interest has a
   * terminating expansion, and truncated with a trailing marker when it does
   * not, so a third never reads as if it were 33.33% on the nose.
   */
  toPercentString(places = 4): string {
    const scale = 10n ** BigInt(places);
    const scaled = (this.numerator * 100n * scale) / this.denominator;
    const exact = this.numerator * 100n * scale === scaled * this.denominator;
    const whole = scaled / scale;
    const fraction = scaled % scale;
    let text = whole.toString();
    if (fraction > 0n) {
      const digits = fraction.toString().padStart(places, "0").replace(/0+$/, "");
      text += `.${digits}`;
    }
    return `${text}${exact ? "" : "…"}%`;
  }

  toString(): string {
    return this.toPercentString();
  }

  /**
   * A string that `parse` reads back to the same interest.
   *
   * Percentages are the readable form and the one a document should normally
   * carry, but two thirds has no decimal expansion, and writing 66.6667% into
   * a file that is later read back is a quiet loss of the exactness the whole
   * type exists for. So a non-terminating interest serialises as its ratio.
   */
  toJSON(): string {
    return this.isTerminating() ? this.toPercentString(20) : this.toRatioString();
  }

  /** Whether the percentage has a finite decimal expansion. */
  isTerminating(): boolean {
    // A fraction in lowest terms terminates in base 10 exactly when its
    // denominator's only prime factors are 2 and 5. The percentage carries a
    // factor of 100, which supplies two of each.
    let d = this.denominator;
    for (const prime of [2n, 5n]) {
      while (d % prime === 0n) d /= prime;
    }
    return d === 1n;
  }

  /**
   * Read either form: `"80%"`, `"80"`, `"0.6"` as a percentage is ambiguous and
   * is not accepted without the sign, and `"2/3"` for the ones that need it.
   */
  static parse(value: string): Interest {
    const text = value.trim();
    const ratio = /^(\d+)\s*\/\s*(\d+)$/.exec(text);
    if (ratio !== null) return Interest.of(BigInt(ratio[1] as string), BigInt(ratio[2] as string));
    return Interest.ofPercent(text);
  }

  /** The ratio itself, for a reader who wants to see where a third came from. */
  toRatioString(): string {
    return `${this.numerator}/${this.denominator}`;
  }
}
