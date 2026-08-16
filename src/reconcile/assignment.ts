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

export interface WeightedEdge {
  readonly row: number;
  readonly col: number;
  readonly weight: number;
}

/**
 * Union-find over `rows + cols` nodes, columns offset by `rows`.
 *
 * Path compression only, no union by rank: the graphs here are small enough
 * that the second optimisation buys nothing, and one fewer array is one fewer
 * thing to get wrong.
 */
function componentsOf(edges: readonly WeightedEdge[], rows: number, cols: number): number[] {
  const parent = Array.from({ length: rows + cols }, (_, i) => i);

  const find = (node: number): number => {
    let root = node;
    while ((parent[root] as number) !== root) root = parent[root] as number;
    let walk = node;
    while ((parent[walk] as number) !== walk) {
      const next = parent[walk] as number;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };

  for (const edge of edges) {
    const a = find(edge.row);
    const b = find(rows + edge.col);
    if (a !== b) parent[b] = a;
  }

  return parent.map((_, node) => find(node));
}

/**
 * Maximum-weight matching on a *sparse* graph.
 *
 * The dense solver above needs a complete matrix and pads it to
 * `(rows + cols)` square, so its cost is cubic in the total number of lines
 * whether or not the pairs are plausible. On real books almost none of them
 * are: amount and date rule out well over ninety-nine percent of pairs before
 * anything is scored, and what remains is a graph of small islands — a handful
 * of movements that share an amount and a fortnight, and nothing else.
 *
 * A matching cannot use an edge between two islands, because there is none. So
 * each connected component can be solved on its own and the answers
 * concatenated, and the result is exactly as optimal as solving the whole thing
 * at once. The cost becomes cubic in the size of the largest island rather than
 * in the size of the books.
 *
 * Where two edges have precisely equal weight the two approaches may pick
 * different ones — both being, by definition, equally good. The total is what
 * is guaranteed identical, and that is what the property tests pin.
 */
export function maximumWeightMatchingSparse(
  edges: readonly WeightedEdge[],
  rows: number,
  cols: number,
  options: AssignmentOptions = {},
): AssignmentResult {
  const threshold = options.threshold ?? -INF;

  const usable = edges.filter((edge) => {
    if (!Number.isFinite(edge.weight)) return false;
    if (edge.row < 0 || edge.row >= rows) {
      throw new AssignmentShapeError(`Edge row ${edge.row} is outside 0..${rows - 1}`);
    }
    if (edge.col < 0 || edge.col >= cols) {
      throw new AssignmentShapeError(`Edge column ${edge.col} is outside 0..${cols - 1}`);
    }
    return true;
  });

  const roots = componentsOf(usable, rows, cols);
  const byComponent = new Map<number, WeightedEdge[]>();
  for (const edge of usable) {
    const root = roots[edge.row] as number;
    let group = byComponent.get(root);
    if (group === undefined) {
      group = [];
      byComponent.set(root, group);
    }
    group.push(edge);
  }

  const pairs: AssignmentPair[] = [];

  // Components in ascending order of their lowest row, so the answer does not
  // depend on Map iteration order.
  const ordered = [...byComponent.values()].sort(
    (a, b) => Math.min(...a.map((e) => e.row)) - Math.min(...b.map((e) => e.row)),
  );

  for (const group of ordered) {
    const localRows = [...new Set(group.map((edge) => edge.row))].sort((a, b) => a - b);
    const localCols = [...new Set(group.map((edge) => edge.col))].sort((a, b) => a - b);
    const rowAt = new Map(localRows.map((row, i) => [row, i]));
    const colAt = new Map(localCols.map((col, j) => [col, j]));

    // A component of one edge is the whole answer for that component; running
    // a 2x2 Hungarian solve to discover it is pure overhead, and singletons are
    // the overwhelming majority on real books.
    if (group.length === 1) {
      const only = group[0] as WeightedEdge;
      if (only.weight >= threshold) pairs.push(Object.freeze({ ...only }));
      continue;
    }

    const dense: number[][] = localRows.map(() => new Array<number>(localCols.length).fill(-INF));
    for (const edge of group) {
      const i = rowAt.get(edge.row) as number;
      const j = colAt.get(edge.col) as number;
      // Parallel edges should not exist, but if the caller supplies them the
      // better one is the one that matters.
      const existing = (dense[i] as number[])[j] as number;
      if (edge.weight > existing) (dense[i] as number[])[j] = edge.weight;
    }

    const solved = maximumWeightMatching(dense, options);
    for (const pair of solved.pairs) {
      pairs.push(
        Object.freeze({
          row: localRows[pair.row] as number,
          col: localCols[pair.col] as number,
          weight: pair.weight,
        }),
      );
    }
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
