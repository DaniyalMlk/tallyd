/**
 * Scoring the matcher itself.
 *
 * A reconciliation engine can be wrong in two directions and they are not
 * equally bad. Missing a match costs a reviewer a minute. *Making* a wrong
 * match costs them an afternoon, because the evidence has been consumed and the
 * two lines it should have paired are now stranded somewhere else in the
 * report. So the two are reported separately rather than folded into one
 * accuracy number that hides which kind of wrong it is.
 *
 * The vocabulary is the standard one, applied to whole matches rather than
 * lines. A match is *correct* when the exact set of book lines and the exact
 * set of statement lines in it agree with the ground truth; a batch that got
 * eight of its nine invoices is not eight-ninths right, it is wrong, because a
 * reviewer given it would have to redo the work.
 *
 * `suggested` matches are counted apart from `matched` ones throughout. A
 * suggestion the engine got wrong is not a failure of the same kind: it was
 * shown to a human and labelled as needing a decision, which is the system
 * working as designed.
 */

import type { Match, ReconciliationResult } from "./matcher.js";

/** One statement line and the book lines it really came from. */
export interface TruthLink {
  readonly statementId: string;
  readonly bookIds: readonly string[];
}

export interface AccuracyReport {
  /** Auto-accepted matches that agree with the truth exactly. */
  readonly correct: number;
  /** Auto-accepted matches that pair lines the truth says do not belong together. */
  readonly wrong: number;
  /** True links the engine neither matched nor suggested. */
  readonly missed: number;
  /** Suggestions that turn out to be right — work saved, but not claimed. */
  readonly suggestedCorrect: number;
  /** Suggestions that turn out to be wrong — a reviewer's time, not an error. */
  readonly suggestedWrong: number;
  /** Links in the ground truth. */
  readonly expected: number;
  /**
   * Of the pairings the engine committed to, the share that were right.
   * The number that matters: a low precision means it is inventing matches.
   */
  readonly precision: number;
  /** Of the pairings that existed, the share the engine committed to. */
  readonly recall: number;
  /** Recall counting suggestions as found, which is what a reviewer sees. */
  readonly recallWithSuggestions: number;
  /** Harmonic mean of precision and recall over committed matches. */
  readonly f1: number;
  /** The wrong auto-accepted matches, for looking at. */
  readonly failures: readonly AccuracyFailure[];
}

export interface AccuracyFailure {
  readonly statementIds: readonly string[];
  readonly bookIds: readonly string[];
  readonly score: number;
  readonly reason: "no truth for these lines" | "paired the wrong lines";
}

/** A canonical key for a set of ids, so two orderings compare equal. */
function setKey(ids: readonly string[]): string {
  return [...new Set(ids)].sort().join("+");
}

function matchKey(match: Match): { statement: string; book: string } {
  return {
    statement: setKey(match.statement.map((line) => line.id)),
    book: setKey(match.book.map((line) => line.id)),
  };
}

/**
 * Fold the ground truth into the same shape a match has.
 *
 * Truth arrives one statement line at a time, but a many-to-one match covers
 * several statement lines at once, so links that share book lines have to be
 * merged before the two can be compared. Union-find over the shared ids does
 * it: two links belong together exactly when they touch the same book line.
 */
function truthGroups(truth: readonly TruthLink[]): Map<string, string> {
  const owner = new Map<string, number>();
  const parent: number[] = [];

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
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  truth.forEach((link, index) => {
    parent[index] = index;
    for (const id of link.bookIds) {
      const seen = owner.get(id);
      if (seen === undefined) owner.set(id, index);
      else union(seen, index);
    }
  });

  const statementsByRoot = new Map<number, string[]>();
  const booksByRoot = new Map<number, string[]>();
  truth.forEach((link, index) => {
    const root = find(index);
    let statements = statementsByRoot.get(root);
    if (statements === undefined) {
      statements = [];
      statementsByRoot.set(root, statements);
    }
    statements.push(link.statementId);

    let books = booksByRoot.get(root);
    if (books === undefined) {
      books = [];
      booksByRoot.set(root, books);
    }
    books.push(...link.bookIds);
  });

  // Keyed by the statement side, valued by the book side: a proposed match is
  // correct when its statement key is present and its book key agrees.
  const groups = new Map<string, string>();
  for (const [root, statements] of statementsByRoot) {
    groups.set(setKey(statements), setKey(booksByRoot.get(root) ?? []));
  }
  return groups;
}

/**
 * How well did this reconciliation do against what really happened?
 */
export function measureAccuracy(
  result: ReconciliationResult,
  truth: readonly TruthLink[],
): AccuracyReport {
  const groups = truthGroups(truth);
  const found = new Set<string>();
  const failures: AccuracyFailure[] = [];

  let correct = 0;
  let wrong = 0;
  for (const match of result.matched) {
    const key = matchKey(match);
    const expected = groups.get(key.statement);
    if (expected === key.book) {
      correct += 1;
      found.add(key.statement);
    } else {
      wrong += 1;
      failures.push(
        Object.freeze({
          statementIds: Object.freeze(match.statement.map((line) => line.id)),
          bookIds: Object.freeze(match.book.map((line) => line.id)),
          score: match.scored.score,
          reason: expected === undefined ? "no truth for these lines" : "paired the wrong lines",
        }),
      );
    }
  }

  let suggestedCorrect = 0;
  let suggestedWrong = 0;
  for (const match of result.suggested) {
    const key = matchKey(match);
    if (groups.get(key.statement) === key.book) {
      suggestedCorrect += 1;
      found.add(key.statement);
    } else {
      suggestedWrong += 1;
    }
  }

  const expected = groups.size;
  const committed = correct + wrong;
  const precision = committed === 0 ? 1 : correct / committed;
  const recall = expected === 0 ? 1 : correct / expected;
  const recallWithSuggestions = expected === 0 ? 1 : found.size / expected;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return Object.freeze({
    correct,
    wrong,
    missed: expected - found.size,
    suggestedCorrect,
    suggestedWrong,
    expected,
    precision,
    recall,
    recallWithSuggestions,
    f1,
    failures: Object.freeze(failures),
  });
}

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

export function renderAccuracy(report: AccuracyReport): string {
  return [
    `expected ${report.expected}  correct ${report.correct}  wrong ${report.wrong}  missed ${report.missed}`,
    `suggested ${report.suggestedCorrect} right / ${report.suggestedWrong} wrong`,
    `precision ${percent(report.precision)}  recall ${percent(report.recall)}` +
      `  recall incl. suggestions ${percent(report.recallWithSuggestions)}  F1 ${report.f1.toFixed(3)}`,
  ].join("\n");
}
