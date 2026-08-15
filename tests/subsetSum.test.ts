import { describe, expect, it } from "vitest";
import { findSubsets, findBestSubset } from "../src/reconcile/subsetSum.js";

const minor = (...values: number[]): bigint[] => values.map((v) => BigInt(v));

/** Brute force over every subset, used to check the pruned search. */
function bruteForce(values: readonly bigint[], target: bigint, maxSize: number): number[][] {
  const found: number[][] = [];
  const n = values.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const indices: number[] = [];
    let total = 0n;
    for (let i = 0; i < n; i++) {
      if ((mask & (1 << i)) !== 0) {
        indices.push(i);
        total += values[i] as bigint;
      }
    }
    if (indices.length <= maxSize && total === target) found.push(indices);
  }
  return found;
}

describe("findSubsets", () => {
  it("finds a single value that hits the target", () => {
    const result = findSubsets(minor(1000, 2500, 700), 2500n);
    expect(result.subsets.map((s) => s.indices)).toEqual([[1]]);
    expect(result.subsets[0]?.delta).toBe(0n);
    expect(result.exhaustive).toBe(true);
  });

  it("finds a batch payment split across several ledger entries", () => {
    // £1,240.00 out of the bank; three supplier invoices in the books.
    const result = findSubsets(minor(-42000, -60000, -22000, -155000, -18000), -124000n);
    expect(result.subsets[0]?.indices).toEqual([0, 1, 2]);
    expect(result.subsets[0]?.total).toBe(-124000n);
  });

  it("returns nothing when no combination reaches the target", () => {
    const result = findSubsets(minor(100, 200, 400), 350n);
    expect(result.subsets).toEqual([]);
    expect(result.exhaustive).toBe(true);
  });

  it("returns nothing for empty input", () => {
    const result = findSubsets([], 0n);
    expect(result.subsets).toEqual([]);
    expect(result.nodesVisited).toBe(0);
  });

  it("respects the maximum group size", () => {
    const values = minor(100, 100, 100, 100);
    expect(findSubsets(values, 300n, { maxSize: 2 }).subsets).toEqual([]);
    expect(findSubsets(values, 300n, { maxSize: 3 }).subsets.length).toBeGreaterThan(0);
  });

  it("respects a minimum group size, for callers that only want real groups", () => {
    const values = minor(500, 300, 200);
    const singles = findSubsets(values, 500n);
    const groups = findSubsets(values, 500n, { minSize: 2 });
    expect(singles.subsets[0]?.indices).toEqual([0]);
    expect(groups.subsets.map((s) => s.indices)).toEqual([[1, 2]]);
  });

  it("accepts near misses within tolerance and reports the shortfall", () => {
    const result = findSubsets(minor(1999), 2000n, { tolerance: 5n });
    expect(result.subsets[0]?.indices).toEqual([0]);
    expect(result.subsets[0]?.delta).toBe(-1n);

    expect(findSubsets(minor(1990), 2000n, { tolerance: 5n }).subsets).toEqual([]);
  });

  it("handles mixed signs, where a refund offsets a charge", () => {
    const result = findSubsets(minor(-5000, 1200, -700), -4500n);
    expect(result.subsets[0]?.indices).toEqual([0, 1, 2]);
  });

  it("puts the smallest and closest explanations first", () => {
    const result = findSubsets(minor(1000, 600, 400, 999), 1000n, { tolerance: 2n });
    const sizes = result.subsets.map((s) => s.indices.length);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect(result.subsets[0]?.indices).toEqual([0]);
    expect(result.subsets[1]?.indices).toEqual([3]);
  });

  it("agrees with brute force on exhaustive small cases", () => {
    let seed = 20260814;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const randInt = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

    for (let trial = 0; trial < 400; trial++) {
      const n = randInt(1, 10);
      const values = Array.from({ length: n }, () => BigInt(randInt(-600, 600)));
      const target = BigInt(randInt(-1200, 1200));
      const maxSize = randInt(1, 4);

      const expected = bruteForce(values, target, maxSize).map((i) => i.join(","));
      const actual = findSubsets(values, target, {
        maxSize,
        maxResults: 1_000_000,
        nodeBudget: 5_000_000,
      });

      expect(actual.exhaustive).toBe(true);
      const got = actual.subsets.map((s) => s.indices.join(","));
      expect([...got].sort()).toEqual([...new Set(expected)].sort());
    }
  });

  it("only ever returns subsets that really sum to the target", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let trial = 0; trial < 300; trial++) {
      const n = 2 + Math.floor(rnd() * 14);
      const values = Array.from({ length: n }, () => BigInt(Math.floor(rnd() * 20000) - 10000));
      const target = BigInt(Math.floor(rnd() * 20000) - 10000);
      const tolerance = BigInt(Math.floor(rnd() * 20));
      const result = findSubsets(values, target, { tolerance, maxSize: 4 });
      for (const subset of result.subsets) {
        const total = subset.indices.reduce((sum, i) => sum + (values[i] as bigint), 0n);
        expect(total).toBe(subset.total);
        expect(subset.total - target).toBe(subset.delta);
        const distance = subset.delta < 0n ? -subset.delta : subset.delta;
        expect(distance <= tolerance).toBe(true);
        expect(subset.indices).toEqual([...subset.indices].sort((a, b) => a - b));
        expect(new Set(subset.indices).size).toBe(subset.indices.length);
      }
    }
  });

  it("is deterministic across repeated runs", () => {
    const values = minor(1200, -400, 800, 400, -1200, 600, 600, 200);
    const once = findSubsets(values, 1200n, { maxSize: 4 });
    const twice = findSubsets(values, 1200n, { maxSize: 4 });
    expect(once.subsets.map((s) => s.indices)).toEqual(twice.subsets.map((s) => s.indices));
    expect(once.nodesVisited).toBe(twice.nodesVisited);
  });

  it("stops on the node budget rather than running away", () => {
    // 40 equal values with a target nothing reaches: the search space is huge
    // and every branch has to be considered.
    const values = Array.from({ length: 40 }, () => 101n);
    const result = findSubsets(values, 1_000_000n, { maxSize: 8, nodeBudget: 500 });
    expect(result.nodesVisited).toBeLessThanOrEqual(500);
    expect(result.exhaustive).toBe(true); // pruning kills it before the budget bites
  });

  it("reports a truncated search honestly", () => {
    const values = Array.from({ length: 24 }, () => 100n);
    const result = findSubsets(values, 200n, { maxSize: 2, maxResults: 5 });
    expect(result.subsets).toHaveLength(5);
    expect(result.exhaustive).toBe(false);
  });

  it("prunes hard enough to finish a wide search quickly", () => {
    const values = Array.from({ length: 60 }, (_, i) => BigInt((i + 1) * 137));
    const target = 137n * 3n + 137n * 17n + 137n * 41n;
    const result = findSubsets(values, target, { maxSize: 3, maxResults: 200 });
    expect(result.subsets.length).toBeGreaterThan(0);
    expect(result.nodesVisited).toBeLessThan(200_000);
    for (const subset of result.subsets) {
      expect(subset.total).toBe(target);
    }
  });

  it("finds groups containing a zero-valued entry without losing the shorter one", () => {
    const result = findSubsets(minor(500, 0), 500n, { maxSize: 2 });
    expect(result.subsets.map((s) => s.indices)).toEqual([[0], [0, 1]]);
  });
});

describe("findBestSubset", () => {
  it("returns the smallest exact explanation", () => {
    expect(findBestSubset(minor(1000, 600, 400), 1000n)?.indices).toEqual([0]);
  });

  it("returns null when there is nothing to find", () => {
    expect(findBestSubset(minor(1, 2, 3), 99n)).toBeNull();
    expect(findBestSubset([], 0n)).toBeNull();
  });
});
