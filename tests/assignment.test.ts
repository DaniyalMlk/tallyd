import { describe, expect, it } from "vitest";
import {
  maximumWeightMatching,
  greedyMatching,
  AssignmentShapeError,
} from "../src/reconcile/assignment.js";

/** Optimal total by exhaustive search over all injections rows -> cols. */
function bruteForceOptimal(weights: readonly (readonly number[])[]): number {
  const rows = weights.length;
  const cols = weights[0]?.length ?? 0;
  let best = 0;

  const walk = (row: number, used: boolean[], total: number): void => {
    if (row === rows) {
      if (total > best) best = total;
      return;
    }
    // Leaving a row unassigned is allowed; a negative-weight pair is never
    // forced on us.
    walk(row + 1, used, total);
    for (let col = 0; col < cols; col++) {
      if (used[col] === true) continue;
      const weight = (weights[row] as readonly number[])[col] as number;
      if (!Number.isFinite(weight)) continue;
      used[col] = true;
      walk(row + 1, used, total + weight);
      used[col] = false;
    }
  };

  walk(0, new Array<boolean>(cols).fill(false), 0);
  return best;
}

describe("maximumWeightMatching", () => {
  it("pairs a one-by-one matrix", () => {
    const result = maximumWeightMatching([[0.9]]);
    expect(result.pairs).toEqual([{ row: 0, col: 0, weight: 0.9 }]);
    expect(result.total).toBeCloseTo(0.9, 12);
    expect(result.unassignedRows).toEqual([]);
    expect(result.unassignedCols).toEqual([]);
  });

  it("handles empty input", () => {
    expect(maximumWeightMatching([]).pairs).toEqual([]);
    expect(maximumWeightMatching([[]]).pairs).toEqual([]);
    expect(maximumWeightMatching([[]]).unassignedRows).toEqual([0]);
  });

  it("takes the diagonal when the diagonal is best", () => {
    const result = maximumWeightMatching([
      [1.0, 0.1, 0.1],
      [0.1, 1.0, 0.1],
      [0.1, 0.1, 1.0],
    ]);
    expect(result.pairs.map((p) => [p.row, p.col])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
    expect(result.total).toBeCloseTo(3, 12);
  });

  it("beats greedy where greedy is trapped by its first pick", () => {
    // Greedy takes 0.95 (row 0, col 0) and leaves row 1 with 0.10.
    // Optimal gives col 0 to row 1 and col 1 to row 0: 0.90 + 0.90 = 1.80.
    const weights = [
      [0.95, 0.9],
      [0.9, 0.1],
    ];
    const greedy = greedyMatching(weights);
    const optimal = maximumWeightMatching(weights);
    expect(greedy.total).toBeCloseTo(1.05, 12);
    expect(optimal.total).toBeCloseTo(1.8, 12);
    expect(optimal.total).toBeGreaterThan(greedy.total);
  });

  it("leaves surplus columns unassigned when there are more columns than rows", () => {
    const result = maximumWeightMatching([[0.2, 0.8, 0.5]]);
    expect(result.pairs).toEqual([{ row: 0, col: 1, weight: 0.8 }]);
    expect(result.unassignedRows).toEqual([]);
    expect(result.unassignedCols).toEqual([0, 2]);
  });

  it("leaves surplus rows unassigned when there are more rows than columns", () => {
    const result = maximumWeightMatching([[0.2], [0.8], [0.5]]);
    expect(result.pairs).toEqual([{ row: 1, col: 0, weight: 0.8 }]);
    expect(result.unassignedRows).toEqual([0, 2]);
    expect(result.unassignedCols).toEqual([]);
  });

  it("never takes a forbidden pair while any alternative exists", () => {
    const result = maximumWeightMatching([
      [Number.NEGATIVE_INFINITY, 0.4],
      [0.3, Number.NEGATIVE_INFINITY],
    ]);
    expect(result.pairs.map((p) => [p.row, p.col])).toEqual([
      [0, 1],
      [1, 0],
    ]);
  });

  it("drops every pair when the whole matrix is forbidden", () => {
    const forbidden = Number.NEGATIVE_INFINITY;
    const result = maximumWeightMatching([
      [forbidden, forbidden],
      [forbidden, forbidden],
    ]);
    expect(result.pairs).toEqual([]);
    expect(result.unassignedRows).toEqual([0, 1]);
    expect(result.unassignedCols).toEqual([0, 1]);
  });

  it("applies the threshold after solving, not before", () => {
    const weights = [
      [0.95, 0.9],
      [0.9, 0.1],
    ];
    const result = maximumWeightMatching(weights, { threshold: 0.5 });
    // The optimal assignment is 0.9 + 0.9; both survive a 0.5 threshold.
    expect(result.pairs.map((p) => p.weight)).toEqual([0.9, 0.9]);

    const strict = maximumWeightMatching(weights, { threshold: 0.92 });
    expect(strict.pairs).toEqual([]);
    expect(strict.unassignedRows).toEqual([0, 1]);
  });

  it("rejects ragged matrices and NaN weights", () => {
    expect(() => maximumWeightMatching([[1, 2], [3]])).toThrow(AssignmentShapeError);
    expect(() => maximumWeightMatching([[Number.NaN]])).toThrow(AssignmentShapeError);
  });

  it("matches brute-force optimal on random square matrices", () => {
    let seed = 424242;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

    for (let trial = 0; trial < 300; trial++) {
      const n = 1 + Math.floor(rnd() * 5);
      const weights = Array.from({ length: n }, () =>
        Array.from({ length: n }, () => Math.round(rnd() * 1000) / 1000),
      );
      const solved = maximumWeightMatching(weights);
      expect(solved.total).toBeCloseTo(bruteForceOptimal(weights), 9);
      expect(new Set(solved.pairs.map((p) => p.row)).size).toBe(solved.pairs.length);
      expect(new Set(solved.pairs.map((p) => p.col)).size).toBe(solved.pairs.length);
    }
  });

  it("matches brute-force optimal on random rectangular matrices, both orientations", () => {
    let seed = 1337;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

    for (let trial = 0; trial < 300; trial++) {
      const rows = 1 + Math.floor(rnd() * 5);
      const cols = 1 + Math.floor(rnd() * 5);
      const weights = Array.from({ length: rows }, () =>
        Array.from({ length: cols }, () => Math.round(rnd() * 100) / 100),
      );
      const solved = maximumWeightMatching(weights);
      expect(solved.total).toBeCloseTo(bruteForceOptimal(weights), 9);
      // A zero-weight pair is worth exactly as much as no pair at all, so the
      // count is bounded rather than fixed.
      expect(solved.pairs.length).toBeLessThanOrEqual(Math.min(rows, cols));
    }
  });

  it("stays optimal when some pairs are forbidden", () => {
    let seed = 5150;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

    for (let trial = 0; trial < 200; trial++) {
      const rows = 1 + Math.floor(rnd() * 4);
      const cols = 1 + Math.floor(rnd() * 4);
      const weights = Array.from({ length: rows }, () =>
        Array.from({ length: cols }, () =>
          rnd() < 0.3 ? Number.NEGATIVE_INFINITY : Math.round(rnd() * 100) / 100,
        ),
      );
      const solved = maximumWeightMatching(weights);
      expect(solved.total).toBeCloseTo(bruteForceOptimal(weights), 9);
      for (const pair of solved.pairs) {
        expect(Number.isFinite((weights[pair.row] as number[])[pair.col] as number)).toBe(true);
      }
    }
  });

  it("is at least as good as greedy on every random matrix", () => {
    let seed = 90210;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

    for (let trial = 0; trial < 300; trial++) {
      const rows = 1 + Math.floor(rnd() * 6);
      const cols = 1 + Math.floor(rnd() * 6);
      const weights = Array.from({ length: rows }, () =>
        Array.from({ length: cols }, () => Math.round(rnd() * 100) / 100),
      );
      expect(maximumWeightMatching(weights).total).toBeGreaterThanOrEqual(
        greedyMatching(weights).total - 1e-9,
      );
    }
  });

  it("solves a 60 x 80 matrix without complaint", () => {
    let seed = 31337;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const weights = Array.from({ length: 60 }, () =>
      Array.from({ length: 80 }, () => Math.round(rnd() * 100) / 100),
    );
    const solved = maximumWeightMatching(weights);
    expect(solved.pairs.length).toBe(60);
    expect(solved.total).toBeGreaterThanOrEqual(greedyMatching(weights).total);
  });
});

describe("greedyMatching", () => {
  it("takes the highest-scoring pair first", () => {
    const result = greedyMatching([
      [0.5, 0.99],
      [0.4, 0.98],
    ]);
    expect(result.pairs).toEqual([
      { row: 0, col: 1, weight: 0.99 },
      { row: 1, col: 0, weight: 0.4 },
    ]);
  });

  it("honours the threshold and skips forbidden pairs", () => {
    const result = greedyMatching(
      [
        [0.9, Number.NEGATIVE_INFINITY],
        [0.2, 0.3],
      ],
      { threshold: 0.25 },
    );
    expect(result.pairs).toEqual([
      { row: 0, col: 0, weight: 0.9 },
      { row: 1, col: 1, weight: 0.3 },
    ]);
  });
});
