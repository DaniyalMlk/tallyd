import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Interest, InterestError } from "../src/group/interest.js";
import { GBP, JPY } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";

describe("an interest is an exact fraction", () => {
  it("normalises to lowest terms", () => {
    const i = Interest.of(50n, 100n);
    expect(i.numerator).toBe(1n);
    expect(i.denominator).toBe(2n);
  });

  it("reads a percentage exactly rather than through a float", () => {
    const i = Interest.ofPercent("33.333");
    expect(i.numerator).toBe(33333n);
    expect(i.denominator).toBe(100000n);
  });

  it("accepts a trailing percent sign and surrounding space", () => {
    expect(Interest.ofPercent("  80 % ").equals(Interest.of(4n, 5n))).toBe(true);
  });

  it("reads basis points", () => {
    expect(Interest.ofBasisPoints(8000).equals(Interest.ofPercent("80"))).toBe(true);
    expect(Interest.ofBasisPoints(10000).isWhole).toBe(true);
  });

  it("refuses an interest outside nought to one", () => {
    expect(() => Interest.ofPercent("101")).toThrow(InterestError);
    expect(() => Interest.ofPercent("-1")).toThrow(InterestError);
    expect(() => Interest.of(3n, 2n)).toThrow(InterestError);
    expect(() => Interest.of(1n, 0n)).toThrow(InterestError);
  });

  it("refuses a percentage that is not one", () => {
    expect(() => Interest.ofPercent("")).toThrow(InterestError);
    expect(() => Interest.ofPercent("eighty")).toThrow(InterestError);
    expect(() => Interest.ofPercent(Number.NaN)).toThrow(InterestError);
  });

  it("normalises a negative denominator instead of carrying one", () => {
    const i = Interest.of(-1n, -2n);
    expect(i.numerator).toBe(1n);
    expect(i.denominator).toBe(2n);
  });

  it("treats nought as nought however it is written", () => {
    expect(Interest.of(0n, 7n).equals(Interest.none)).toBe(true);
    expect(Interest.of(0n, 7n).denominator).toBe(1n);
  });
});

describe("a chain of holdings multiplies exactly", () => {
  it("two thirds of three quarters is a half, not 50.0025%", () => {
    const chain = Interest.of(2n, 3n).times(Interest.of(3n, 4n));
    expect(chain.numerator).toBe(1n);
    expect(chain.denominator).toBe(2n);
    expect(chain.toPercentString()).toBe("50%");
  });

  it("eighty of seventy-five is sixty", () => {
    const chain = Interest.ofPercent("80").times(Interest.ofPercent("75"));
    expect(chain.equals(Interest.ofPercent("60"))).toBe(true);
  });

  it("a whole holding leaves the chain unchanged", () => {
    const i = Interest.ofPercent("62.5");
    expect(Interest.whole.times(i).equals(i)).toBe(true);
    expect(i.times(Interest.whole).equals(i)).toBe(true);
  });

  it("nought anywhere in the chain makes the whole chain nought", () => {
    expect(Interest.ofPercent("80").times(Interest.none).isZero).toBe(true);
  });

  it("adds two holdings in the same company", () => {
    const combined = Interest.ofPercent("30").plus(Interest.ofPercent("25.5"));
    expect(combined.equals(Interest.ofPercent("55.5"))).toBe(true);
  });

  it("refuses to add past the whole", () => {
    expect(() => Interest.ofPercent("60").plus(Interest.ofPercent("60"))).toThrow(InterestError);
  });

  it("subtracts, and refuses to go below nought", () => {
    expect(Interest.ofPercent("60").minus(Interest.ofPercent("15")).toPercentString()).toBe("45%");
    expect(() => Interest.ofPercent("10").minus(Interest.ofPercent("60"))).toThrow(InterestError);
  });

  it("takes a complement that is exact even for a third", () => {
    const third = Interest.of(1n, 3n);
    expect(third.complement().numerator).toBe(2n);
    expect(third.complement().denominator).toBe(3n);
    expect(third.plus(third.complement()).isWhole).toBe(true);
  });
});

describe("control is a different question from ownership", () => {
  it("a bare majority controls", () => {
    expect(Interest.ofPercent("50.01").isControlling).toBe(true);
    expect(Interest.ofPercent("50").isControlling).toBe(false);
    expect(Interest.ofPercent("49.99").isControlling).toBe(false);
  });

  it("an exact half does not, and the test does not depend on a float", () => {
    expect(Interest.of(1n, 2n).isControlling).toBe(false);
    expect(Interest.of(500000001n, 1000000000n).isControlling).toBe(true);
  });

  it("a chain that controls at every link can still own a minority", () => {
    // 80% of a company holding 75% of a third: control throughout, 60% owned.
    const effective = Interest.ofPercent("80").times(Interest.ofPercent("75"));
    expect(effective.isControlling).toBe(true);
    expect(effective.complement().toPercentString()).toBe("40%");
  });

  it("a long chain of majorities falls below half", () => {
    let chain = Interest.whole;
    for (let i = 0; i < 3; i += 1) chain = chain.times(Interest.ofPercent("60"));
    // 0.6^3 = 0.216
    expect(chain.equals(Interest.ofPercent("21.6"))).toBe(true);
    expect(chain.isControlling).toBe(false);
  });
});

describe("taking a share of money", () => {
  it("takes a plain share", () => {
    expect(Interest.ofPercent("40").share(Money.parse("100.00", GBP)).toDecimalString()).toBe(
      "40.00",
    );
  });

  it("rounds the last minor unit rather than reaching a float", () => {
    // A third of 1p is 0.333 of a penny.
    const third = Interest.of(1n, 3n);
    expect(third.share(Money.ofMinor(1n, GBP)).minorUnits).toBe(0n);
    expect(third.share(Money.ofMinor(2n, GBP)).minorUnits).toBe(1n);
    expect(third.share(Money.ofMinor(5n, GBP), "half-up").minorUnits).toBe(2n);
  });

  it("works in a currency with no minor units", () => {
    expect(Interest.ofPercent("50").share(Money.parse("101", JPY)).toDecimalString()).toBe("50");
  });

  it("keeps the sign of what it is a share of", () => {
    const share = Interest.ofPercent("25").share(Money.parse("-40.00", GBP));
    expect(share.toDecimalString()).toBe("-10.00");
  });

  it("splits so the two sides sum back exactly", () => {
    const amount = Money.ofMinor(101n, GBP);
    const { mine, theirs } = Interest.of(1n, 3n).splitOf(amount);
    expect(mine.plus(theirs).equals(amount)).toBe(true);
    expect(mine.minorUnits).toBe(34n);
    expect(theirs.minorUnits).toBe(67n);
  });
});

describe("reading and writing", () => {
  it("prints a terminating percentage exactly", () => {
    expect(Interest.ofPercent("62.5").toPercentString()).toBe("62.5%");
    expect(Interest.whole.toPercentString()).toBe("100%");
    expect(Interest.none.toPercentString()).toBe("0%");
  });

  it("marks a percentage that does not terminate rather than pretending", () => {
    expect(Interest.of(1n, 3n).toPercentString(4)).toBe("33.3333…%");
    expect(Interest.of(1n, 3n).isTerminating()).toBe(false);
    expect(Interest.of(5n, 8n).isTerminating()).toBe(true);
  });

  it("round-trips a terminating interest through its percentage", () => {
    const i = Interest.ofPercent("33.333");
    expect(Interest.parse(i.toJSON()).equals(i)).toBe(true);
  });

  it("round-trips a non-terminating interest through its ratio", () => {
    const third = Interest.of(1n, 3n);
    expect(third.toJSON()).toBe("1/3");
    expect(Interest.parse(third.toJSON()).equals(third)).toBe(true);
  });

  it("orders by value and not by the way it was written", () => {
    expect(Interest.of(1n, 3n).compare(Interest.ofPercent("33.33"))).toBe(1);
    expect(Interest.ofPercent("25").compare(Interest.of(1n, 4n))).toBe(0);
    expect(Interest.ofPercent("10").compare(Interest.ofPercent("90"))).toBe(-1);
  });

  it("shows the ratio when someone wants to see where a third came from", () => {
    expect(Interest.of(2n, 6n).toRatioString()).toBe("1/3");
  });

  it("converts to a number only for display", () => {
    expect(Interest.ofPercent("80").toNumber()).toBeCloseTo(0.8, 12);
  });
});

describe("properties", () => {
  const anyInterest = fc
    .tuple(fc.bigInt({ min: 0n, max: 10000n }), fc.bigInt({ min: 1n, max: 10000n }))
    .map(([a, b]) => Interest.of(a <= b ? a : b, b));

  it("a share and its complement always sum back to the amount", () => {
    fc.assert(
      fc.property(anyInterest, fc.bigInt({ min: -1000000000n, max: 1000000000n }), (i, minor) => {
        const amount = Money.ofMinor(minor, GBP);
        const { mine, theirs } = i.splitOf(amount);
        expect(mine.plus(theirs).equals(amount)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it("multiplication never leaves the unit interval", () => {
    fc.assert(
      fc.property(anyInterest, anyInterest, (a, b) => {
        const product = a.times(b);
        expect(product.compare(Interest.whole)).toBeLessThanOrEqual(0);
        expect(product.compare(a)).toBeLessThanOrEqual(0);
        expect(product.compare(b)).toBeLessThanOrEqual(0);
      }),
      { numRuns: 2000 },
    );
  });

  it("the complement of the complement is the interest", () => {
    fc.assert(
      fc.property(anyInterest, (i) => {
        expect(i.complement().complement().equals(i)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it("what is written can be read back", () => {
    fc.assert(
      fc.property(anyInterest, (i) => {
        expect(Interest.parse(i.toJSON()).equals(i)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });
});
