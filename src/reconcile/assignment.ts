/**
 * Maximum-weight bipartite matching.
 *
 * Scoring pairs is the easy half. The hard half is choosing between them: if
 * two statement lines both look like the same ledger entry, taking whichever
 * scored highest and moving on can leave the other one stranded against a much
 * worse partner, and the total quality of the reconciliation is worse than it
 * needed to be. Greedy is locally right and globally wrong.
 *
 * This is the Hungarian algorithm in its shortest-augmenting-path form
 * (Jonker-Volgenant style, with potentials): O(n^2 m) on an n x m matrix, which
 * for a month of bank statement against a month of ledger is nothing.
 *
 * The solver minimises cost, so weights are negated on the way in. Pairs the
 * caller has ruled out entirely are passed as `-Infinity` and become a
 * prohibitive finite cost — the algorithm needs a complete matrix, and a
 * forbidden pair is simply one that will never be worth taking.
 */

export interface AssignmentPair {
  readonly row: number;
  readonly col: number;
  readonly weight: number;
}

export interface AssignmentResult {
  readonly pairs: readonly AssignmentPair[];
  /** Sum of the weights of the returned pairs. */
  readonly total: number;
  /** Rows left without a column. */
  readonly unassignedRows: readonly number[];
  /** Columns left without a row. */
  readonly unassignedCols: readonly number[];
}

export interface AssignmentOptions {
  /**
   * Pairs scoring below this are dropped after the assignment is solved, not
   * before: a low-scoring pair can still be worth including while the solver
   * decides who goes where. Default `-Infinity`, which keeps everything.
   */
  threshold?: number;
}

export class AssignmentShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssignmentShapeError";
  }
}

const INF = Number.POSITIVE_INFINITY;

function assertRectangular(weights: readonly (readonly number[])[]): number {
  const width = weights[0]?.length ?? 0;
  for (const row of weights) {
    if (row.length !== width) {
      throw new AssignmentShapeError("Every row of the weight matrix must be the same length");
    }
    for (const value of row) {
      if (Number.isNaN(value)) {
        throw new AssignmentShapeError("Weight matrix must not contain NaN");
      }
    }
  }
  return width;
}

/**
 * Solve the rectangular assignment problem on `cost`, minimising. Returns, for
 * each row, the column it was given. Requires rows <= cols.
 */
function solveMinCost(cost: readonly (readonly number[])[], rows: number, cols: number): number[] {
  // 1-indexed working arrays; index 0 is the sentinel the algorithm augments
  // from. u and v are the dual potentials, p[j] is the row assigned to column j.
  const u = new Array<number>(rows + 1).fill(0);
  const v = new Array<number>(cols + 1).fill(0);
  const p = new Array<number>(cols + 1).fill(0);
  const way = new Array<number>(cols + 1).fill(0);

  for (let i = 1; i <= rows; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(cols + 1).fill(INF);
    const used = new Array<boolean>(cols + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0] as number;
      let delta = INF;
      let j1 = 0;

      for (let j = 1; j <= cols; j++) {
        if (used[j] === true) continue;
        const current = (cost[i0 - 1] as readonly number[])[j - 1] as number;
        const reduced = current - (u[i0] as number) - (v[j] as number);
        if (reduced < (minv[j] as number)) {
          minv[j] = reduced;
          way[j] = j0;
        }
        if ((minv[j] as number) < delta) {
          delta = minv[j] as number;
          j1 = j;
        }
      }

      for (let j = 0; j <= cols; j++) {
        if (used[j] === true) {
          u[p[j] as number] = (u[p[j] as number] as number) + delta;
          v[j] = (v[j] as number) - delta;
        } else {
          minv[j] = (minv[j] as number) - delta;
        }
      }

      j0 = j1;
    } while ((p[j0] as number) !== 0);

    // Walk the alternating path back, shifting each assignment along it.
    do {
      const j1 = way[j0] as number;
      p[j0] = p[j1] as number;
      j0 = j1;
    } while (j0 !== 0);
  }

  const rowToCol = new Array<number>(rows).fill(-1);
  for (let j = 1; j <= cols; j++) {
    const row = p[j] as number;
    if (row > 0) rowToCol[row - 1] = j - 1;
  }
  return rowToCol;
}

/**
 * The pairing of rows to columns with the greatest total weight, at most one
 * column per row and one row per column.
 */
export function maximumWeightMatching(
  weights: readonly (readonly number[])[],
  options: AssignmentOptions = {},
): AssignmentResult {
  const rows = weights.length;
  const cols = assertRectangular(weights);
  const threshold = options.threshold ?? -INF;

  if (rows === 0 || cols === 0) {
    return Object.freeze({
      pairs: Object.freeze([] as AssignmentPair[]),
      total: 0,
      unassignedRows: Object.freeze(Array.from({ length: rows }, (_, i) => i)),
      unassignedCols: Object.freeze(Array.from({ length: cols }, (_, j) => j)),
    });
  }

  // A forbidden pair has to become a finite cost the solver will avoid. One
  // step worse than every real pair put together is enough: no optimal
  // solution takes one while any alternative exists.
  let span = 1;
  for (const row of weights) {
    for (const value of row) {
      if (Number.isFinite(value)) span = Math.max(span, Math.abs(value));
    }
  }
  const forbidden = span * (rows + cols + 1) * 4;

  // The Hungarian algorithm solves a *perfect* matching, which is the wrong
  // problem: it would rather pair a statement line with something it plainly
  // is not than leave it alone. So the matrix is padded to (rows + cols)
  // square with a free "unassigned" partner for every row and every column.
  // Leaving everything unmatched is then a feasible zero-profit solution, and
  // no pair worth less than nothing can ever be forced into the answer.
  const size = rows + cols;
  const cost: number[][] = [];
  for (let i = 0; i < size; i++) {
    const row = new Array<number>(size).fill(0);
    if (i < rows) {
      for (let j = 0; j < cols; j++) {
        const weight = (weights[i] as readonly number[])[j] as number;
        row[j] = Number.isFinite(weight) ? -weight : forbidden;
      }
    }
    cost.push(row);
  }

  const solved = solveMinCost(cost, size, size);

  const pairs: AssignmentPair[] = [];
  for (let i = 0; i < rows; i++) {
    const j = solved[i] as number;
    if (j < 0 || j >= cols) continue;
    const weight = (weights[i] as readonly number[])[j] as number;
    if (!Number.isFinite(weight) || weight < threshold) continue;
    pairs.push(Object.freeze({ row: i, col: j, weight }));
  }

  pairs.sort((a, b) => (a.row === b.row ? a.col - b.col : a.row - b.row));

  const takenRows = new Set(pairs.map((pair) => pair.row));
  const takenCols = new Set(pairs.map((pair) => pair.col));

  return Object.freeze({
    pairs: Object.freeze(pairs),
    total: pairs.reduce((sum, pair) => sum + pair.weight, 0),
    unassignedRows: Object.freeze(
      Array.from({ length: rows }, (_, i) => i).filter((i) => !takenRows.has(i)),
    ),
    unassignedCols: Object.freeze(
      Array.from({ length: cols }, (_, j) => j).filter((j) => !takenCols.has(j)),
    ),
  });
}

/**
 * Greedy matching — take the best remaining pair until nothing is left.
 *
 * Kept because it is the obvious approach, and because the test suite uses it
 * to show that it really can be beaten: on a matrix where one row's second
 * choice frees up a much better pairing for another, greedy scores strictly
 * less than the optimal assignment.
 */
export function greedyMatching(
  weights: readonly (readonly number[])[],
  options: AssignmentOptions = {},
): AssignmentResult {
  const rows = weights.length;
  const cols = assertRectangular(weights);
  const threshold = options.threshold ?? -INF;

  const candidates: AssignmentPair[] = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const weight = (weights[i] as readonly number[])[j] as number;
      if (!Number.isFinite(weight) || weight < threshold) continue;
      candidates.push(Object.freeze({ row: i, col: j, weight }));
    }
  }
  candidates.sort((a, b) => (b.weight - a.weight) || (a.row - b.row) || (a.col - b.col));

  const takenRows = new Set<number>();
  const takenCols = new Set<number>();
  const pairs: AssignmentPair[] = [];
  for (const candidate of candidates) {
    if (takenRows.has(candidate.row) || takenCols.has(candidate.col)) continue;
    takenRows.add(candidate.row);
    takenCols.add(candidate.col);
    pairs.push(candidate);
  }
  pairs.sort((a, b) => (a.row === b.row ? a.col - b.col : a.row - b.row));

  return Object.freeze({
    pairs: Object.freeze(pairs),
    total: pairs.reduce((sum, pair) => sum + pair.weight, 0),
    unassignedRows: Object.freeze(
      Array.from({ length: rows }, (_, i) => i).filter((i) => !takenRows.has(i)),
    ),
    unassignedCols: Object.freeze(
      Array.from({ length: cols }, (_, j) => j).filter((j) => !takenCols.has(j)),
    ),
  });
}
