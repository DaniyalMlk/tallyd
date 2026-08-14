import { describe, it, expect } from "vitest";
import { Money, GBP, JPY, KWD, sumMoney } from "../src/money/index.js";

// Deterministic LCG so failures are reproducible.
let seed = 0x2f6e2b1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const randInt = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

describe("allocation conserves every minor unit", () => {
  it("split(n) never creates or destroys value, across 20k random cases", () => {
    for (let i = 0; i < 20000; i++) {
      const cur = [GBP, JPY, KWD][randInt(0, 2)];
      const amount = BigInt(randInt(-5_000_000, 5_000_000));
      const parts = randInt(1, 40);
      const m = Money.ofMinor(amount, cur);
      const pieces = m.split(parts);
      expect(pieces).toHaveLength(parts);
      expect(sumMoney(pieces, cur).minorUnits).toBe(amount);
      // largest-remainder: no two pieces may differ by more than one minor unit
      const mins = pieces.map((p) => p.minorUnits);
      expect(mins.reduce((a, b) => (a > b ? a : b)) - mins.reduce((a, b) => (a < b ? a : b)))
        .toBeLessThanOrEqual(1n);
    }
  });

  it("allocate(weights) conserves value on lopsided and zero weights", () => {
    const cases: (number | bigint)[][] = [
      [1, 1, 1], [0, 0, 1], [1, 0], [999999, 1], [1, 1, 1, 1, 1, 1, 1],
      [3, 5, 7, 11, 13], [1n, 2n, 3n], [0, 0, 0, 5],
    ];
    for (const w of cases) {
      for (const amt of [1n, 2n, 5n, 100n, 101n, -101n, 999983n, 0n]) {
        const m = Money.ofMinor(amt, GBP);
        const out = m.allocate(w);
        expect(sumMoney(out, GBP).minorUnits).toBe(amt);
        expect(out).toHaveLength(w.length);
      }
    }
  });

  it("the classic 100/3 case", () => {
    const out = Money.ofMinor(10000n, GBP).split(3);
    expect(out.map((m) => m.minorUnits)).toEqual([3334n, 3333n, 3333n]);
    expect(sumMoney(out, GBP).minorUnits).toBe(10000n);
  });

  it("negative amounts allocate without drifting a unit", () => {
    const out = Money.ofMinor(-10000n, GBP).split(3);
    expect(sumMoney(out, GBP).minorUnits).toBe(-10000n);
  });
});
