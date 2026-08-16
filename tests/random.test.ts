import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Random } from "../src/demo/random.js";

describe("Random is reproducible", () => {
  it("gives the same sequence for the same seed", () => {
    const a = new Random(42);
    const b = new Random(42);
    const first = Array.from({ length: 200 }, () => a.next());
    const second = Array.from({ length: 200 }, () => b.next());
    expect(first).toEqual(second);
  });

  it("gives different sequences for different seeds", () => {
    const a = Array.from({ length: 50 }, () => 0).map(() => new Random(1).next());
    const b = new Random(2).next();
    expect(a[0]).not.toBe(b);
  });

  it("does not collapse when seeded with zero", () => {
    const random = new Random(0);
    const draws = new Set(Array.from({ length: 100 }, () => random.next()));
    expect(draws.size).toBeGreaterThan(90);
  });

  it("does not collapse when seeded with a negative number", () => {
    const random = new Random(-7);
    const draws = new Set(Array.from({ length: 100 }, () => random.next()));
    expect(draws.size).toBeGreaterThan(90);
  });

  it("truncates a fractional seed rather than producing a fractional state", () => {
    const a = Array.from({ length: 10 }, () => 0);
    const one = new Random(9.9);
    const two = new Random(9);
    expect(a.map(() => one.next())).toEqual(a.map(() => two.next()));
  });
});

describe("Random draws stay inside their bounds", () => {
  it("float is in [0, 1)", () => {
    const random = new Random(7);
    for (let i = 0; i < 5000; i++) {
      const value = random.float();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("int includes both ends", () => {
    const random = new Random(11);
    const seen = new Set<number>();
    for (let i = 0; i < 3000; i++) seen.add(random.int(3, 6));
    expect([...seen].sort((a, b) => a - b)).toEqual([3, 4, 5, 6]);
  });

  it("int on a single-value range always returns it", () => {
    const random = new Random(5);
    for (let i = 0; i < 20; i++) expect(random.int(4, 4)).toBe(4);
  });

  it("int rejects an empty range", () => {
    expect(() => new Random(1).int(5, 4)).toThrow(RangeError);
  });

  it("skewed stays inside its range", () => {
    const random = new Random(13);
    for (let i = 0; i < 5000; i++) {
      const value = random.skewed(10, 20);
      expect(value).toBeGreaterThanOrEqual(10);
      expect(value).toBeLessThanOrEqual(20);
    }
  });

  it("skewed really does skew low", () => {
    const random = new Random(17);
    const draws = Array.from({ length: 4000 }, () => random.skewed(0, 100));
    const mean = draws.reduce((sum, value) => sum + value, 0) / draws.length;
    expect(mean).toBeLessThan(40);
  });

  it("chance(0) never fires and chance(1) always does", () => {
    const random = new Random(19);
    for (let i = 0; i < 500; i++) {
      expect(random.chance(0)).toBe(false);
      expect(random.chance(1)).toBe(true);
    }
  });

  it("chance is roughly calibrated", () => {
    const random = new Random(23);
    const hits = Array.from({ length: 20000 }, () => random.chance(0.25)).filter(Boolean).length;
    expect(hits / 20000).toBeGreaterThan(0.23);
    expect(hits / 20000).toBeLessThan(0.27);
  });
});

describe("Random over collections", () => {
  it("pick rejects an empty list", () => {
    expect(() => new Random(1).pick([])).toThrow(RangeError);
  });

  it("pick returns a member of the list", () => {
    const random = new Random(29);
    const items = ["a", "b", "c"];
    for (let i = 0; i < 200; i++) expect(items).toContain(random.pick(items));
  });

  it("shuffle is a permutation and leaves the input alone", () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { minLength: 0, maxLength: 40 }), fc.integer(), (items, seed) => {
        const original = [...items];
        const shuffled = new Random(seed).shuffle(items);
        expect(items).toEqual(original);
        expect([...shuffled].sort((a, b) => a - b)).toEqual([...items].sort((a, b) => a - b));
      }),
      { numRuns: 300 },
    );
  });

  it("shuffle actually reorders", () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    const shuffled = new Random(31).shuffle(items);
    expect(shuffled).not.toEqual(items);
  });
});
