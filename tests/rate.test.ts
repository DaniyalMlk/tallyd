import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ExchangeRate, RateError, rate } from "../src/fx/rate.js";
import { EUR, GBP, JPY, KWD, USD } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";

describe("a rate is an exact rational, not a float", () => {
  it("keeps a decimal literal exactly, in lowest terms", () => {
    const r = rate("0.8500", EUR, GBP);
    expect(r.numerator).toBe(17n);
    expect(r.denominator).toBe(20n);
    expect(r.toDecimalString(4)).toBe("0.8500");
  });

  it("survives a price no binary float can hold", () => {
    // 1.1 * 3 is 3.3000000000000003 in IEEE-754.
    const r = rate("1.1", EUR, GBP);
    const tripled = ExchangeRate.ofRatio(r.numerator * 3n, r.denominator, EUR, GBP);
    expect(tripled.toDecimalString(20)).toBe("3.30000000000000000000");
  });

  it("normalises a negative denominator rather than carrying a negative price", () => {
    const r = ExchangeRate.ofRatio(-17n, -20n, EUR, GBP);
    expect(r.numerator).toBe(17n);
    expect(r.denominator).toBe(20n);
  });

  it("refuses a zero or negative price", () => {
    expect(() => rate("0", EUR, GBP)).toThrow(RateError);
    expect(() => rate("-1.2", EUR, GBP)).toThrow(RateError);
    expect(() => ExchangeRate.ofRatio(1n, 0n, EUR, GBP)).toThrow(RateError);
  });

  it("refuses a pair of one currency, which would be a rate of nothing", () => {
    expect(() => rate("1.0", EUR, EUR)).toThrow(RateError);
  });

  it("refuses text that is not a number", () => {
    expect(() => rate("about a euro", EUR, GBP)).toThrow(RateError);
  });

  it("accepts scientific notation, because rate files sometimes carry it", () => {
    expect(rate("8.473e-1", EUR, GBP).toDecimalString(4)).toBe("0.8473");
  });
});

describe("inversion and composition", () => {
  it("inverts to the reciprocal, with the pair reversed", () => {
    const r = rate("1.25", GBP, USD);
    const back = r.inverse();
    expect(back.pair).toBe("USD/GBP");
    expect(back.toDecimalString(2)).toBe("0.80");
  });

  it("inverting twice is the identity, exactly", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        (n, d) => {
          const r = ExchangeRate.ofRatio(n, d, EUR, GBP);
          expect(r.inverse().inverse().equals(r)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("composes two legs into one, without an intermediate rounding", () => {
    const eurUsd = rate("1.0837", EUR, USD);
    const usdGbp = rate("0.7912", USD, GBP);
    const eurGbp = eurUsd.then(usdGbp);
    expect(eurGbp.pair).toBe("EUR/GBP");
    // 1.0837 * 0.7912 = 0.85742344 exactly.
    expect(eurGbp.toDecimalString(8)).toBe("0.85742344");
  });

  it("refuses to chain legs that do not meet", () => {
    expect(() => rate("1.08", EUR, USD).then(rate("0.79", GBP, JPY))).toThrow(RateError);
  });

  it("composing a leg and then its inverse returns to where it started", () => {
    const eurUsd = rate("1.0837", EUR, USD);
    const usdGbp = rate("0.7912", USD, GBP);
    expect(eurUsd.then(usdGbp).then(usdGbp.inverse()).equals(eurUsd)).toBe(true);
  });

  it("refuses to compose a pair back onto itself", () => {
    const eurUsd = rate("1.0837", EUR, USD);
    expect(() => eurUsd.then(eurUsd.inverse())).toThrow(RateError);
  });

  it("compares two prices of the same pair", () => {
    expect(rate("1.25", GBP, USD).compare(rate("1.30", GBP, USD))).toBe(-1);
    expect(rate("1.30", GBP, USD).compare(rate("1.25", GBP, USD))).toBe(1);
    expect(rate("1.250", GBP, USD).compare(rate("1.25", GBP, USD))).toBe(0);
  });

  it("refuses to compare different pairs", () => {
    expect(() => rate("1.25", GBP, USD).compare(rate("1.25", EUR, USD))).toThrow(RateError);
  });
});

describe("conversion", () => {
  it("converts between two two-decimal currencies", () => {
    const r = rate("0.8473", EUR, GBP);
    expect(r.convert(Money.parse("1000.00", EUR)).toDecimalString()).toBe("847.30");
  });

  it("handles a currency with no minor unit on the quote side", () => {
    const r = rate("190.25", GBP, JPY);
    // 1902.5 yen exactly, and half-even sends a tie to the even neighbour.
    expect(r.convert(Money.parse("10.00", GBP)).toDecimalString()).toBe("1902");
    expect(r.convert(Money.parse("10.00", GBP), "half-up").toDecimalString()).toBe("1903");
  });

  it("handles a currency with no minor unit on the base side", () => {
    const r = rate("0.005256", JPY, GBP);
    expect(r.convert(Money.parse("100000", JPY)).toDecimalString()).toBe("525.60");
  });

  it("handles three minor digits", () => {
    const r = rate("2.6", KWD, GBP);
    expect(r.convert(Money.parse("1.234", KWD)).toDecimalString()).toBe("3.21");
  });

  it("rounds once at the end, not once per leg", () => {
    const legA = rate("1.5", EUR, USD);
    const legB = rate("1.5", USD, GBP);
    const amount = Money.parse("0.01", EUR);

    // Converting leg by leg rounds 0.015 up to 0.02 and then multiplies the
    // rounding error by the second leg.
    const stepwise = legB.convert(legA.convert(amount));
    expect(stepwise.toDecimalString()).toBe("0.03");

    // The true answer is 0.0225, which rounds to 0.02.
    const composed = legA.then(legB).convert(amount);
    expect(legA.then(legB).toDecimalString(4)).toBe("2.2500");
    expect(composed.toDecimalString()).toBe("0.02");
  });

  it("honours the rounding mode it is given", () => {
    const r = rate("0.845", EUR, GBP);
    const amount = Money.parse("1.00", EUR);
    expect(r.convert(amount, "down").toDecimalString()).toBe("0.84");
    expect(r.convert(amount, "up").toDecimalString()).toBe("0.85");
    expect(r.convert(amount, "half-even").toDecimalString()).toBe("0.84");
    expect(r.convert(amount, "half-up").toDecimalString()).toBe("0.85");
  });

  it("converts a negative amount without changing its sign", () => {
    const r = rate("0.8473", EUR, GBP);
    expect(r.convert(Money.parse("-1000.00", EUR)).toDecimalString()).toBe("-847.30");
  });

  it("refuses an amount that is not in the base currency", () => {
    expect(() => rate("0.8473", EUR, GBP).convert(Money.parse("10.00", USD))).toThrow(RateError);
  });

  it("apply picks the direction from the amount", () => {
    const r = rate("0.80", EUR, GBP);
    expect(r.apply(Money.parse("100.00", EUR)).toString()).toBe("80.00 GBP");
    expect(r.apply(Money.parse("80.00", GBP)).toString()).toBe("100.00 EUR");
    expect(() => r.apply(Money.parse("80.00", USD))).toThrow(RateError);
  });

  it("converting a whole amount and back lands within a minor unit", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -(10 ** 9), max: 10 ** 9 }),
        fc.integer({ min: 5000, max: 500000 }),
        (minor, priceTenThousandths) => {
          const r = ExchangeRate.ofRatio(BigInt(priceTenThousandths), 10000n, EUR, GBP);
          const original = Money.ofMinor(minor, EUR);
          const round = r.inverse().convert(r.convert(original));
          const drift = round.minus(original).abs();
          // The round trip can only lose what one rounding at each end can lose.
          expect(drift.minorUnits <= 10000n / BigInt(priceTenThousandths) + 1n).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("a rate implied by two amounts", () => {
  it("recovers the price used to convert", () => {
    const implied = ExchangeRate.implied(Money.parse("1000.00", EUR), Money.parse("847.30", GBP));
    expect(implied.toDecimalString(4)).toBe("0.8473");
    expect(implied.pair).toBe("EUR/GBP");
  });

  it("works across differing minor units", () => {
    const implied = ExchangeRate.implied(Money.parse("10000", JPY), Money.parse("52.56", GBP));
    expect(implied.toDecimalString(6)).toBe("0.005256");
  });

  it("reads a pair of credits the same way as a pair of debits", () => {
    const debits = ExchangeRate.implied(Money.parse("100.00", EUR), Money.parse("85.00", GBP));
    const credits = ExchangeRate.implied(Money.parse("-100.00", EUR), Money.parse("-85.00", GBP));
    expect(credits.equals(debits)).toBe(true);
  });

  it("refuses a zero on either side", () => {
    expect(() => ExchangeRate.implied(Money.zero(EUR), Money.parse("1.00", GBP))).toThrow(RateError);
    expect(() => ExchangeRate.implied(Money.parse("1.00", EUR), Money.zero(GBP))).toThrow(RateError);
  });

  it("refuses opposite signs, which would imply a negative price", () => {
    expect(() =>
      ExchangeRate.implied(Money.parse("100.00", EUR), Money.parse("-85.00", GBP)),
    ).toThrow(RateError);
  });
});

describe("presentation", () => {
  it("renders to a requested number of places, rounding half-even", () => {
    const r = ExchangeRate.ofRatio(2n, 3n, EUR, GBP);
    expect(r.toDecimalString(0)).toBe("1");
    expect(r.toDecimalString(2)).toBe("0.67");
    expect(r.toDecimalString(6)).toBe("0.666667");
  });

  it("rejects an absurd precision", () => {
    expect(() => rate("1.2", EUR, GBP).toDecimalString(-1)).toThrow(RateError);
    expect(() => rate("1.2", EUR, GBP).toDecimalString(21)).toThrow(RateError);
  });

  it("reads as a sentence", () => {
    expect(rate("0.8473", EUR, GBP).toString()).toBe("1 EUR = 0.847300 GBP");
  });

  it("round-trips through JSON", () => {
    const r = rate("0.8473", EUR, GBP);
    const json = r.toJSON();
    expect(json).toEqual({ base: "EUR", quote: "GBP", rate: "0.8473000000" });
    expect(ExchangeRate.of(json.rate, json.base, json.quote).equals(r)).toBe(true);
  });

  it("gives a float only when asked", () => {
    expect(rate("0.8473", EUR, GBP).toNumber()).toBeCloseTo(0.8473, 10);
  });
});
