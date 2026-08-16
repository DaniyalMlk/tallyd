import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  AssignmentShapeError,
  maximumWeightMatching,
  maximumWeightMatchingSparse,
  type WeightedEdge,
} from "../src/reconcile/assignment.js";

/** The same problem as a dense matrix, for comparing the two solvers. */
function densify(edges: readonly WeightedEdge[], rows: number, cols: number): number[][] {
  const dense = Array.from({ length: rows }, () => new Array<number>(cols).fill(Number.NEGATIVE_INFINITY));
  for (const edge of edges) {
    const row = dense[edge.row] as number[];
    if (edge.weight > (row[edge.col] as number)) row[edge.col] = edge.weight;
  }
  return dense;
}

describe("the sparse solver on hand-built cases", () => {
  it("returns nothing for no edges", () => {
    const result = maximumWeightMatchingSparse([], 3, 4);
    expect(result.pairs).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.unassignedRows).toEqual([0, 1, 2]);
    expect(result.unassignedCols).toEqual([0, 1, 2, 3]);
  });

  it("takes a lone edge", () => {
    const result = maximumWeightMatchingSparse([{ row: 1, col: 2, weight: 0.9 }], 3, 3);
    expect(result.pairs).toEqual([{ row: 1, col: 2, weight: 0.9 }]);
    expect(result.total).toBe(0.9);
  });

  it("beats greedy where greedy is beatable", () => {
    // Greedy grabs (0,0) at 1.0 and leaves row 1 with nothing; the optimum
    // takes 0.9 + 0.8 instead.
    const edges: WeightedEdge[] = [
      { row: 0, col: 0, weight: 1.0 },
      { row: 0, col: 1, weight: 0.9 },
      { row: 1, col: 0, weight: 0.8 },
    ];
    const result = maximumWeightMatchingSparse(edges, 2, 2);
    expect(result.total).toBeCloseTo(1.7, 10);
    expect(result.pairs.length).toBe(2);
  });

  it("solves two islands independently", () => {
    const edges: WeightedEdge[] = [
      { row: 0, col: 0, weight: 0.5 },
      { row: 1, col: 1, weight: 0.6 },
    ];
    const result = maximumWeightMatchingSparse(edges, 2, 2);
    expect(result.total).toBeCloseTo(1.1, 10);
  });

  it("drops pairs below the threshold after solving", () => {
    const edges: WeightedEdge[] = [
      { row: 0, col: 0, weight: 0.9 },
      { row: 1, col: 1, weight: 0.2 },
    ];
    const result = maximumWeightMatchingSparse(edges, 2, 2, { threshold: 0.5 });
    expect(result.pairs).toEqual([{ row: 0, col: 0, weight: 0.9 }]);
    expect(result.unassignedRows).toEqual([1]);
  });

  it("keeps the better of two parallel edges", () => {
    const edges: WeightedEdge[] = [
      { row: 0, col: 0, weight: 0.3 },
      { row: 0, col: 0, weight: 0.8 },
      { row: 0, col: 1, weight: 0.4 },
      { row: 1, col: 1, weight: 0.4 },
    ];
    const result = maximumWeightMatchingSparse(edges, 2, 2);
    // 0.8 + 0.4 beats 0.4 + 0.4, but only if the 0.3 duplicate was discarded.
    expect(result.total).toBeCloseTo(1.2, 10);
    expect(result.pairs).toContainEqual({ row: 0, col: 0, weight: 0.8 });
  });

  it("ignores an infinite weight rather than solving with it", () => {
    const edges: WeightedEdge[] = [
      { row: 0, col: 0, weight: Number.NEGATIVE_INFINITY },
      { row: 1, col: 1, weight: 0.4 },
    ];
    const result = maximumWeightMatchingSparse(edges, 2, 2);
    expect(result.pairs).toEqual([{ row: 1, col: 1, weight: 0.4 }]);
  });

  it("rejects an edge pointing outside the grid", () => {
    expect(() => maximumWeightMatchingSparse([{ row: 5, col: 0, weight: 1 }], 2, 2)).toThrow(
      AssignmentShapeError,
    );
    expect(() => maximumWeightMatchingSparse([{ row: 0, col: 9, weight: 1 }], 2, 2)).toThrow(
      AssignmentShapeError,
    );
    expect(() => maximumWeightMatchingSparse([{ row: -1, col: 0, weight: 1 }], 2, 2)).toThrow(
      AssignmentShapeError,
    );
  });

  it("returns pairs in row order regardless of edge order", () => {
    const edges: WeightedEdge[] = [
      { row: 2, col: 2, weight: 0.7 },
      { row: 0, col: 0, weight: 0.7 },
      { row: 1, col: 1, weight: 0.7 },
    ];
    const result = maximumWeightMatchingSparse(edges, 3, 3);
    expect(result.pairs.map((pair) => pair.row)).toEqual([0, 1, 2]);
  });

  it("never uses a row or a column twice", () => {
    const edges: WeightedEdge[] = [
      { row: 0, col: 0, weight: 0.9 },
      { row: 0, col: 1, weight: 0.9 },
      { row: 1, col: 0, weight: 0.9 },
      { row: 1, col: 1, weight: 0.9 },
    ];
    const result = maximumWeightMatchingSparse(edges, 2, 2);
    expect(new Set(result.pairs.map((p) => p.row)).size).toBe(result.pairs.length);
    expect(new Set(result.pairs.map((p) => p.col)).size).toBe(result.pairs.length);
  });
});

describe("the sparse solver agrees with the dense one", () => {
  it("reaches the same total on random sparse graphs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9 }),
        fc.integer({ min: 1, max: 9 }),
        fc.array(fc.tuple(fc.nat(8), fc.nat(8), fc.integer({ min: 1, max: 1000 })), {
          minLength: 0,
          maxLength: 30,
        }),
        (rows, cols, raw) => {
          const edges = raw
            .filter(([row, col]) => row < rows && col < cols)
            .map(([row, col, weight]) => ({ row, col, weight: weight / 1000 }));

          const sparse = maximumWeightMatchingSparse(edges, rows, cols);
          const dense = maximumWeightMatching(densify(edges, rows, cols));

          expect(sparse.total).toBeCloseTo(dense.total, 9);
          expect(sparse.pairs.length).toBe(dense.pairs.length);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("agrees on dense graphs too, where every pair is allowed", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 6 }),
        fc.integer(),
        (rows, cols, seed) => {
          // A deterministic filling, so a failure can be reproduced from the seed.
          let state = (seed >>> 0) || 1;
          const nextWeight = (): number => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return (state % 1000) / 1000;
          };
          const edges: WeightedEdge[] = [];
          for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) edges.push({ row, col, weight: nextWeight() });
          }

          const sparse = maximumWeightMatchingSparse(edges, rows, cols);
          const dense = maximumWeightMatching(densify(edges, rows, cols));
          expect(sparse.total).toBeCloseTo(dense.total, 9);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("agrees once a threshold is applied", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(5), fc.nat(5), fc.integer({ min: 1, max: 1000 })), {
          minLength: 1,
          maxLength: 20,
        }),
        (raw) => {
          const edges = raw.map(([row, col, weight]) => ({ row, col, weight: weight / 1000 }));
          const options = { threshold: 0.5 };
          const sparse = maximumWeightMatchingSparse(edges, 6, 6, options);
          const dense = maximumWeightMatching(densify(edges, 6, 6), options);
          expect(sparse.total).toBeCloseTo(dense.total, 9);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("returns a valid matching over the edges it was given", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(7), fc.nat(7), fc.integer({ min: 1, max: 1000 })), {
          minLength: 0,
          maxLength: 40,
        }),
        (raw) => {
          const edges = raw.map(([row, col, weight]) => ({ row, col, weight: weight / 1000 }));
          const allowed = new Set(edges.map((edge) => `${edge.row}:${edge.col}`));
          const result = maximumWeightMatchingSparse(edges, 8, 8);

          const rows = new Set<number>();
          const cols = new Set<number>();
          for (const pair of result.pairs) {
            expect(allowed.has(`${pair.row}:${pair.col}`)).toBe(true);
            expect(rows.has(pair.row)).toBe(false);
            expect(cols.has(pair.col)).toBe(false);
            rows.add(pair.row);
            cols.add(pair.col);
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("the sparse solver is what makes size affordable", () => {
  it("solves a thousand small islands quickly", () => {
    // Five hundred disjoint 2x2 islands: two rows and two columns that can see
    // each other, and nothing linking one island to the next. This is the shape
    // real books produce, because amount and date agreement is rare.
    const edges: WeightedEdge[] = [];
    for (let island = 0; island < 500; island++) {
      const row = island * 2;
      const col = island * 2;
      edges.push({ row, col, weight: 0.9 });
      edges.push({ row, col: col + 1, weight: 0.6 });
      edges.push({ row: row + 1, col, weight: 0.7 });
      edges.push({ row: row + 1, col: col + 1, weight: 0.5 });
    }

    const started = performance.now();
    const result = maximumWeightMatchingSparse(edges, 1000, 1000);
    const elapsed = performance.now() - started;

    expect(result.pairs.length).toBe(1000);
    // 0.9 + 0.5 beats 0.6 + 0.7, per island.
    expect(result.total).toBeCloseTo(500 * 1.4, 6);
    // The dense solver pads this to 2000x2000 and takes tens of seconds; this
    // is the whole reason the sparse path exists.
    expect(elapsed).toBeLessThan(1000);
  });

  it("is honest about its worst case: one component is still a dense solve", () => {
    // Everything sharing one amount and one date is a single component, and
    // there is no decomposition to exploit. It stays correct; it does not stay
    // fast, and the size below is chosen to prove the first without waiting for
    // the second.
    const edges: WeightedEdge[] = [];
    for (let row = 0; row < 40; row++) {
      for (let col = 0; col < 40; col++) edges.push({ row, col, weight: 0.5 + (row === col ? 0.3 : 0) });
    }
    const result = maximumWeightMatchingSparse(edges, 40, 40);
    expect(result.pairs.length).toBe(40);
    expect(result.total).toBeCloseTo(40 * 0.8, 6);
  });
});
