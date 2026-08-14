import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  CurrencyMismatchError,
  GBP,
  JPY,
  KWD,
  Money,
  USD,
  maxMoney,
  minMoney,
  sumMoney,
} from "../src/money/index.js";

const gbp = (text: string) => Money.parse(text, GBP);

describe("construction", () => {
  it("builds from minor units", () => {
    expect(Money.ofMinor(1250n, GBP).toDecimalString()).toBe("12.50");
    expect(Money.ofMinor(-1n, GBP).toDecimalString()).toBe("-0.01");
  });

  it("accepts a currency by code", () => {
    expect(Money.ofMinor(100n, "usd").currency).toBe(USD);
  });

  it("rejects unsafe integer minor units", () => {
    expect(() => Money.ofMinor(2 ** 53, GBP)).toThrow(RangeError);
    expect(() => Money.ofMinor(1.5, GBP)).toThrow(RangeError);
  });

  it.each([
    ["12.50", 1250n],
    ["12.5", 1250n],
    ["12", 1200n],
    ["-0.01", -1n],
    ["0", 0n],
    ["1,234.56", 123456n],
    ["  7.25  ", 725n],
  ])("parses %s", (text, minor) => {
    expect(gbp(text).minorUnits).toBe(minor);
  });

  it("respects the currency exponent", () => {
    expect(Money.parse("1200", JPY).minorUnits).toBe(1200n);
    expect(Money.parse("1200", JPY).toDecimalString()).toBe("1200");
    expect(Money.parse("1.234", KWD).minorUnits).toBe(1234n);
  });

  it("rejects precision the currency cannot hold", () => {
    expect(() => Money.parse("1.005", GBP)).toThrow(RangeError);
    expect(() => Money.parse("0.5", JPY)).toThrow(RangeError);
  });

  it("allows excess precision when a rounding mode is given", () => {
    expect(Money.parse("1.005", GBP, "half-even").minorUnits).toBe(100n);
    expect(Money.parse("1.015", GBP, "half-even").minorUnits).toBe(102n);
    expect(Money.parse("1.005", GBP, "half-up").minorUnits).toBe(101n);
  });

  it("requires an explicit mode when converting from a number", () => {
    expect(Money.fromNumber(10.555, GBP, "half-up").minorUnits).toBe(1056n);
    expect(Money.fromNumber(10.555, GBP, "down").minorUnits).toBe(1055n);
    // 0.1 + 0.2 is famously 0.30000000000000004 in binary floating point;
    // the shortest-decimal conversion still lands on exactly 30p.
    expect(Money.fromNumber(0.1 + 0.2, GBP, "half-even").minorUnits).toBe(30n);
  });
});

describe("arithmetic", () => {
  it("adds and subtracts exactly", () => {
    expect(gbp("0.10").plus(gbp("0.20")).toDecimalString()).toBe("0.30");
    expect(gbp("100").minus(gbp("0.01")).toDecimalString()).toBe("99.99");
  });

  it("refuses to mix currencies", () => {
    expect(() => Money.ofMinor(1n, GBP).plus(Money.ofMinor(1n, USD))).toThrow(
      CurrencyMismatchError,
    );
    expect(() => Money.ofMinor(1n, GBP).compare(Money.ofMinor(1n, USD))).toThrow(
      CurrencyMismatchError,
    );
  });

  it("reports inequality across currencies rather than throwing", () => {
    expect(Money.ofMinor(1n, GBP).equals(Money.ofMinor(1n, USD))).toBe(false);
  });

  it("multiplies by an integer without rounding", () => {
    expect(gbp("0.07").timesInteger(3).toDecimalString()).toBe("0.21");
    expect(gbp("1.11").timesInteger(-2n).toDecimalString()).toBe("-2.22");
  });

  it("applies a rate with the requested rounding", () => {
    const net = gbp("100.00");
    expect(net.times("0.175").toDecimalString()).toBe("17.50");
    expect(gbp("0.05").times(0.5, "half-even").toDecimalString()).toBe("0.02");
    expect(gbp("0.05").times(0.5, "half-up").toDecimalString()).toBe("0.03");
    expect(gbp("0.05").times("0.5", "up").toDecimalString()).toBe("0.03");
  });

  it("divides with rounding", () => {
    expect(gbp("10.00").dividedBy(3).toDecimalString()).toBe("3.33");
    expect(gbp("10.00").dividedBy("0.5").toDecimalString()).toBe("20.00");
    expect(() => gbp("1.00").dividedBy(0)).toThrow(RangeError);
  });

  it("survives amounts beyond Number.MAX_SAFE_INTEGER", () => {
    const huge = Money.ofMinor(10n ** 30n, GBP);
    expect(huge.plus(huge).minorUnits).toBe(2n * 10n ** 30n);
    expect(huge.timesInteger(3n).minorUnits).toBe(3n * 10n ** 30n);
  });
});

describe("split", () => {
  it("splits without losing a penny", () => {
    const parts = gbp("100.00").split(3);
    expect(parts.map((p) => p.toDecimalString())).toEqual(["33.34", "33.33", "33.33"]);
    expect(sumMoney(parts).equals(gbp("100.00"))).toBe(true);
  });

  it("splits negatives symmetrically", () => {
    const parts = gbp("-100.00").split(3);
    expect(parts.map((p) => p.toDecimalString())).toEqual(["-33.34", "-33.33", "-33.33"]);
    expect(sumMoney(parts).equals(gbp("-100.00"))).toBe(true);
  });

  it("rejects a non-positive part count", () => {
    expect(() => gbp("1.00").split(0)).toThrow(RangeError);
    expect(() => gbp("1.00").split(-2)).toThrow(RangeError);
    expect(() => gbp("1.00").split(1.5)).toThrow(RangeError);
  });

  it("always sums back to the original", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }),
        fc.integer({ min: 1, max: 50 }),
        (minor, parts) => {
          const original = Money.ofMinor(minor, GBP);
          const pieces = original.split(parts);
          expect(pieces).toHaveLength(parts);
          expect(sumMoney(pieces, GBP).equals(original)).toBe(true);
        },
      ),
    );
  });

  it("never spreads the parts by more than one minor unit", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 9n), max: 10n ** 9n }),
        fc.integer({ min: 1, max: 40 }),
        (minor, parts) => {
          const pieces = Money.ofMinor(minor, GBP).split(parts).map((p) => p.minorUnits);
          const lo = pieces.reduce((a, b) => (b < a ? b : a));
          const hi = pieces.reduce((a, b) => (b > a ? b : a));
          expect(hi - lo <= 1n).toBe(true);
        },
      ),
    );
  });
});

describe("allocate", () => {
  it("allocates by weight using largest remainder", () => {
    const parts = gbp("0.05").allocate([3, 7]);
    expect(parts.map((p) => p.toDecimalString())).toEqual(["0.02", "0.03"]);
  });

  it("gives a classic 1-cent-to-the-majority-shareholder result", () => {
    // The canonical Fowler example: 5p split 30/70 must not round to 2p + 4p.
    const parts = Money.ofMinor(5n, GBP).allocate([1, 1, 1]);
    expect(parts.map((p) => p.minorUnits)).toEqual([2n, 2n, 1n]);
  });

  it("breaks remainder ties by position, deterministically", () => {
    const parts = Money.ofMinor(4n, GBP).allocate([1, 1, 1]);
    expect(parts.map((p) => p.minorUnits)).toEqual([2n, 1n, 1n]);
  });

  it("honours zero weights", () => {
    const parts = Money.ofMinor(100n, GBP).allocate([0, 1, 0]);
    expect(parts.map((p) => p.minorUnits)).toEqual([0n, 100n, 0n]);
  });

  it("rejects degenerate weights", () => {
    expect(() => gbp("1.00").allocate([])).toThrow(RangeError);
    expect(() => gbp("1.00").allocate([0, 0])).toThrow(RangeError);
    expect(() => gbp("1.00").allocate([-1, 2])).toThrow(RangeError);
  });

  it("conserves the total for any weights and sign", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 10n), max: 10n ** 10n }),
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 12 }),
        (minor, weights) => {
          fc.pre(weights.some((w) => w > 0));
          const original = Money.ofMinor(minor, GBP);
          const parts = original.allocate(weights);
          expect(parts).toHaveLength(weights.length);
          expect(sumMoney(parts, GBP).equals(original)).toBe(true);
        },
      ),
    );
  });

  it("keeps every share within one unit of its exact proportional value", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 10 }),
        (minor, weights) => {
          const parts = Money.ofMinor(minor, GBP).allocate(weights);
          const total = weights.reduce((a, b) => a + b, 0);
          weights.forEach((w, i) => {
            const exactNumerator = minor * BigInt(w);
            const share = (parts[i] as Money).minorUnits;
            const diff = exactNumerator - share * BigInt(total);
            const bound = BigInt(total);
            expect(diff < bound && diff > -bound).toBe(true);
          });
        },
      ),
    );
  });
});

describe("comparison and helpers", () => {
  it("orders amounts", () => {
    expect(gbp("1.00").lessThan(gbp("2.00"))).toBe(true);
    expect(gbp("2.00").greaterThanOrEqual(gbp("2.00"))).toBe(true);
    expect(gbp("-1.00").compare(gbp("1.00"))).toBe(-1);
  });

  it("supports a tolerance window", () => {
    const tolerance = Money.ofMinor(2n, GBP);
    expect(gbp("10.00").within(gbp("10.02"), tolerance)).toBe(true);
    expect(gbp("10.00").within(gbp("10.03"), tolerance)).toBe(false);
    expect(() => gbp("1.00").within(gbp("1.00"), Money.ofMinor(-1n, GBP))).toThrow(RangeError);
  });

  it("picks minima and maxima", () => {
    expect(minMoney(gbp("1.00"), gbp("2.00")).toDecimalString()).toBe("1.00");
    expect(maxMoney(gbp("1.00"), gbp("2.00")).toDecimalString()).toBe("2.00");
  });

  it("sums an empty list only with an explicit currency", () => {
    expect(sumMoney([], GBP).isZero).toBe(true);
    expect(() => sumMoney([])).toThrow(RangeError);
  });

  it("reports sign", () => {
    expect(gbp("1.00").sign).toBe(1);
    expect(gbp("0").sign).toBe(0);
    expect(gbp("-1.00").sign).toBe(-1);
  });
});

describe("presentation", () => {
  it("formats with symbol and grouping", () => {
    expect(gbp("1234.50").format()).toBe("£1,234.50");
    expect(gbp("-1234.50").format()).toBe("-£1,234.50");
    expect(gbp("1234.50").format({ symbol: false })).toBe("1,234.50");
    expect(gbp("1234.50").format({ grouping: false })).toBe("£1234.50");
    expect(Money.parse("1234", JPY).format()).toBe("¥1,234");
  });

  it("pads the fraction to the currency exponent", () => {
    expect(Money.ofMinor(5n, GBP).toDecimalString()).toBe("0.05");
    expect(Money.ofMinor(5n, KWD).toDecimalString()).toBe("0.005");
  });

  it("round-trips through JSON", () => {
    const original = gbp("-12.34");
    const revived = Money.fromJSON(JSON.parse(JSON.stringify(original)));
    expect(revived.equals(original)).toBe(true);
  });

  it("round-trips any amount through its decimal string", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), (minor) => {
        const original = Money.ofMinor(minor, GBP);
        expect(Money.parse(original.toDecimalString(), GBP).equals(original)).toBe(true);
      }),
    );
  });
});
