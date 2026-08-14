import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ROUNDING_MODES,
  type RoundingMode,
  decimalToRational,
  divideRound,
  numberToRational,
} from "../src/money/rounding.js";

describe("divideRound", () => {
  // Table of (numerator, denominator, expected-per-mode). The denominator is
  // held at 4 so every quarter-step tie case is represented, including the
  // negative mirror image of each.
  const cases: Array<{ n: bigint; d: bigint; expect: Record<RoundingMode, bigint> }> = [
    {
      n: 10n,
      d: 4n, // 2.5 — an exact tie
      expect: {
        ceil: 3n,
        floor: 2n,
        down: 2n,
        up: 3n,
        "half-up": 3n,
        "half-down": 2n,
        "half-even": 2n,
      },
    },
    {
      n: 14n,
      d: 4n, // 3.5 — tie, odd quotient
      expect: {
        ceil: 4n,
        floor: 3n,
        down: 3n,
        up: 4n,
        "half-up": 4n,
        "half-down": 3n,
        "half-even": 4n,
      },
    },
    {
      n: 9n,
      d: 4n, // 2.25 — below the tie
      expect: {
        ceil: 3n,
        floor: 2n,
        down: 2n,
        up: 3n,
        "half-up": 2n,
        "half-down": 2n,
        "half-even": 2n,
      },
    },
    {
      n: 11n,
      d: 4n, // 2.75 — above the tie
      expect: {
        ceil: 3n,
        floor: 2n,
        down: 2n,
        up: 3n,
        "half-up": 3n,
        "half-down": 3n,
        "half-even": 3n,
      },
    },
    {
      n: -10n,
      d: 4n, // -2.5
      expect: {
        ceil: -2n,
        floor: -3n,
        down: -2n,
        up: -3n,
        "half-up": -3n,
        "half-down": -2n,
        "half-even": -2n,
      },
    },
    {
      n: -14n,
      d: 4n, // -3.5
      expect: {
        ceil: -3n,
        floor: -4n,
        down: -3n,
        up: -4n,
        "half-up": -4n,
        "half-down": -3n,
        "half-even": -4n,
      },
    },
    {
      n: 8n,
      d: 4n, // exact, no rounding to do
      expect: {
        ceil: 2n,
        floor: 2n,
        down: 2n,
        up: 2n,
        "half-up": 2n,
        "half-down": 2n,
        "half-even": 2n,
      },
    },
  ];

  for (const { n, d, expect: expected } of cases) {
    for (const mode of ROUNDING_MODES) {
      it(`${n}/${d} under ${mode} is ${expected[mode]}`, () => {
        expect(divideRound(n, d, mode)).toBe(expected[mode]);
      });
    }
  }

  it("normalises a negative denominator", () => {
    expect(divideRound(10n, -4n, "half-up")).toBe(-3n);
    expect(divideRound(-10n, -4n, "half-up")).toBe(3n);
  });

  it("rejects a zero denominator", () => {
    expect(() => divideRound(1n, 0n)).toThrow(RangeError);
  });

  it("handles magnitudes far beyond Number.MAX_SAFE_INTEGER", () => {
    const huge = 10n ** 40n;
    expect(divideRound(huge * 3n + 1n, 3n, "floor")).toBe(huge);
    expect(divideRound(huge * 3n + 1n, 3n, "ceil")).toBe(huge + 1n);
  });

  it("defaults to banker's rounding", () => {
    expect(divideRound(10n, 4n)).toBe(2n);
    expect(divideRound(14n, 4n)).toBe(4n);
  });

  it("never differs from the true quotient by a whole unit", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }),
        fc.bigInt({ min: 1n, max: 10n ** 6n }),
        fc.constantFrom(...ROUNDING_MODES),
        (n, d, mode) => {
          const q = divideRound(n, d, mode);
          const residual = n - q * d;
          expect(residual < d && residual > -d).toBe(true);
        },
      ),
    );
  });

  it("orders the modes consistently: floor <= half-* <= ceil", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 9n), max: 10n ** 9n }),
        fc.bigInt({ min: 1n, max: 10n ** 4n }),
        (n, d) => {
          const floor = divideRound(n, d, "floor");
          const ceil = divideRound(n, d, "ceil");
          for (const mode of ["half-up", "half-down", "half-even"] as const) {
            const v = divideRound(n, d, mode);
            expect(v >= floor && v <= ceil).toBe(true);
          }
        },
      ),
    );
  });
});

describe("decimalToRational", () => {
  it.each([
    ["1", 1n, 1n],
    ["-1", -1n, 1n],
    ["+2.5", 25n, 10n],
    ["0.001", 1n, 1000n],
    [".5", 5n, 10n],
    ["12.", 12n, 1n],
    ["2.5e2", 250n, 1n],
    ["2.5e-2", 25n, 1000n],
    ["-0.0", 0n, 10n],
  ])("parses %s", (input, numerator, denominator) => {
    expect(decimalToRational(input)).toEqual({ numerator, denominator });
  });

  it.each(["", "abc", "1.2.3", "1,000", "--1", "1e", "0x10"])(
    "rejects %s",
    (input) => {
      expect(() => decimalToRational(input)).toThrow(RangeError);
    },
  );

  it("round-trips any decimal produced from a rational", () => {
    fc.assert(
      fc.property(fc.integer({ min: -(10 ** 9), max: 10 ** 9 }), (cents) => {
        const text = (cents / 100).toFixed(2);
        const { numerator, denominator } = decimalToRational(text);
        expect(numerator * 100n).toBe(BigInt(cents) * denominator);
      }),
    );
  });
});

describe("numberToRational", () => {
  it("uses the shortest decimal form, not the binary expansion", () => {
    expect(numberToRational(0.1)).toEqual({ numerator: 1n, denominator: 10n });
    expect(numberToRational(0.3)).toEqual({ numerator: 3n, denominator: 10n });
  });

  it("rejects non-finite input", () => {
    expect(() => numberToRational(Number.NaN)).toThrow(RangeError);
    expect(() => numberToRational(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
