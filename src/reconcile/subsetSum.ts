/**
 * Which combination of these adds up to that?
 *
 * A supplier run leaves the bank as one debit and sits in the books as nine
 * invoices; a lump-sum receipt covers three outstanding sales. Finding the
 * group is subset-sum, which is NP-hard, so this search is bounded on three
 * axes rather than pretending otherwise:
 *
 * - **size**, because a bank line that turns out to be twelve ledger entries is
 *   not a finding anyone can review;
 * - **nodes**, so a pathological input costs a known amount of work and reports
 *   that it gave up rather than hanging;
 * - **results**, since a reviewer reads the first few and no more.
 *
 * Pruning uses running bounds on what the remaining values can still reach, so
 * whole branches die as soon as the target is out of range. Everything works in
 * `bigint` minor units — the whole point of the ledger is that money never
 * touches a float, and that has to hold here too.
 *
 * Results are deterministic: same input, same order, every run. A review queue
 * that reshuffles itself is worse than no review queue.
 */

export interface SubsetSearchOptions {
  /** Largest group to consider. Default 4. */
  maxSize?: number;
  /** How far from the target still counts, in minor units. Default 0. */
  tolerance?: bigint;
  /** Search nodes before giving up. Default 200_000. */
  nodeBudget?: number;
  /** Stop after this many groups. Default 32. */
  maxResults?: number;
  /** Ignore groups smaller than this. Default 1. */
  minSize?: number;
}

export interface Subset {
  /** Indices into the input, ascending. */
  readonly indices: readonly number[];
  readonly total: bigint;
  /** `total - target`; zero on an exact hit. */
  readonly delta: bigint;
}

export interface SubsetSearchResult {
  readonly subsets: readonly Subset[];
  readonly nodesVisited: number;
  /** False when the search stopped on the node or result budget. */
  readonly exhaustive: boolean;
}

const abs = (value: bigint): bigint => (value < 0n ? -value : value);

/**
 * Every subset of `values` summing to `target`, within tolerance and inside
 * the budget.
 *
 * Values are searched in input order so results come back in a stable,
 * explainable sequence, and the caller can map indices straight back onto its
 * own list.
 */
export function findSubsets(
  values: readonly bigint[],
  target: bigint,
  options: SubsetSearchOptions = {},
): SubsetSearchResult {
  const maxSize = Math.max(1, options.maxSize ?? 4);
  const minSize = Math.max(1, options.minSize ?? 1);
  const tolerance = abs(options.tolerance ?? 0n);
  const nodeBudget = Math.max(1, options.nodeBudget ?? 200_000);
  const maxResults = Math.max(1, options.maxResults ?? 32);

  const n = values.length;
  const subsets: Subset[] = [];
  let nodesVisited = 0;
  let exhaustive = true;

  if (n === 0 || minSize > maxSize) {
    return Object.freeze({ subsets: Object.freeze(subsets), nodesVisited: 0, exhaustive: true });
  }

  // suffixPositive[i] is the most the values from i onwards can add; the
  // negative suffix is the least. Any target outside that band is unreachable.
  const suffixPositive = new Array<bigint>(n + 1).fill(0n);
  const suffixNegative = new Array<bigint>(n + 1).fill(0n);
  for (let i = n - 1; i >= 0; i--) {
    const value = values[i] as bigint;
    suffixPositive[i] = (suffixPositive[i + 1] as bigint) + (value > 0n ? value : 0n);
    suffixNegative[i] = (suffixNegative[i + 1] as bigint) + (value < 0n ? value : 0n);
  }

  // The largest absolute values first inside each suffix would prune harder,
  // but reordering would scramble result order, so the bound does the work.
  const chosen: number[] = [];

  const record = (total: bigint): void => {
    subsets.push(
      Object.freeze({
        indices: Object.freeze([...chosen]),
        total,
        delta: total - target,
      }),
    );
  };

  const visit = (index: number, sum: bigint): void => {
    if (subsets.length >= maxResults) {
      exhaustive = false;
      return;
    }
    if (nodesVisited >= nodeBudget) {
      exhaustive = false;
      return;
    }
    nodesVisited++;

    if (chosen.length >= minSize && abs(sum - target) <= tolerance) {
      record(sum);
      // A superset of an exact hit can still be a hit when zero-sum values are
      // in play, so the walk continues rather than returning here.
    }

    if (index >= n) return;
    if (chosen.length >= maxSize) return;

    const remaining = target - sum;
    if (
      remaining > (suffixPositive[index] as bigint) + tolerance ||
      remaining < (suffixNegative[index] as bigint) - tolerance
    ) {
      return;
    }

    for (let i = index; i < n; i++) {
      if (subsets.length >= maxResults || nodesVisited >= nodeBudget) {
        exhaustive = false;
        return;
      }
      // Skip a value that cannot lead anywhere even taken alone with the best
      // the rest of the suffix could contribute.
      const next = sum + (values[i] as bigint);
      const shortfall = target - next;
      if (
        shortfall > (suffixPositive[i + 1] as bigint) + tolerance ||
        shortfall < (suffixNegative[i + 1] as bigint) - tolerance
      ) {
        continue;
      }
      chosen.push(i);
      visit(i + 1, next);
      chosen.pop();
    }
  };

  visit(0, 0n);

  // Smallest groups first — a two-entry explanation beats a four-entry one —
  // then by closeness to the target, then by index order for stability.
  const sorted = [...subsets].sort((a, b) => {
    if (a.indices.length !== b.indices.length) return a.indices.length - b.indices.length;
    const deltaOrder = abs(a.delta) - abs(b.delta);
    if (deltaOrder !== 0n) return deltaOrder < 0n ? -1 : 1;
    for (let i = 0; i < a.indices.length; i++) {
      const left = a.indices[i] as number;
      const right = b.indices[i] as number;
      if (left !== right) return left - right;
    }
    return 0;
  });

  return Object.freeze({
    subsets: Object.freeze(sorted),
    nodesVisited,
    exhaustive,
  });
}

/**
 * The single best group, or `null`. Convenience for callers that only want the
 * smallest exact explanation.
 */
export function findBestSubset(
  values: readonly bigint[],
  target: bigint,
  options: SubsetSearchOptions = {},
): Subset | null {
  const result = findSubsets(values, target, { ...options, maxResults: options.maxResults ?? 8 });
  return result.subsets[0] ?? null;
}
