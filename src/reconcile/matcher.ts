/**
 * The matcher.
 *
 * Given what our books say went through the bank account and what the bank's
 * own statement says, decide which is which. The work happens in two passes,
 * in this order for a reason:
 *
 * 1. **Groups first.** A batch supplier payment leaves the bank as one debit
 *    and sits in the books as nine invoices. If the one-to-one pass ran first
 *    it would pair that bank line with whichever single invoice looked
 *    closest, consume both, and leave the other eight stranded — and the
 *    mistake is unrecoverable, because the evidence has been spent.
 * 2. **Pairs second, and optimally.** What is left goes through maximum-weight
 *    bipartite matching rather than a greedy sweep, so that two statement
 *    lines competing for the same ledger entry are settled by what is best
 *    overall rather than by which was scored first.
 *
 * The output is three buckets, not one. Confident matches, suggestions that
 * need a human, and lines that found nothing. Collapsing the middle bucket into
 * either of the others is how reconciliation tools end up either untrustworthy
 * or useless.
 */

import type { CalendarDate } from "../ledger/date.js";
import { daysBetween } from "../ledger/date.js";
import type { StatementLine } from "../statement/line.js";
import type { BookLine } from "./bankView.js";
import {
  type ScoredMatch,
  type ScoringOptions,
  type ResolvedScoringOptions,
  resolveScoringOptions,
  scorePair,
  scoreGroup,
} from "./scoring.js";
import { findSubsets } from "./subsetSum.js";
import { maximumWeightMatching } from "./assignment.js";

export type MatchKind = "one-to-one" | "one-to-many" | "many-to-one";

export interface Match {
  /** Ledger movements in this match, in input order. */
  readonly book: readonly BookLine[];
  /** Statement lines in this match, in input order. */
  readonly statement: readonly StatementLine[];
  readonly kind: MatchKind;
  readonly scored: ScoredMatch;
}

export interface ReconciliationOptions extends ScoringOptions {
  /** Largest group the subset search will consider on either side. Default 4. */
  maxGroupSize?: number;
  /** Set false to skip group matching entirely. Default true. */
  groupMatching?: boolean;
  /**
   * Date window used when gathering group candidates. Wider than the pair
   * window because a batch spans several days by nature. Default 14.
   */
  groupWindowDays?: number;
}

export interface ReconciliationResult {
  /** Matches at or above the auto-accept score. */
  readonly matched: readonly Match[];
  /** Plausible matches that a human should confirm, best first. */
  readonly suggested: readonly Match[];
  readonly unmatchedBook: readonly BookLine[];
  readonly unmatchedStatement: readonly StatementLine[];
  readonly options: ResolvedScoringOptions;
  readonly stats: ReconciliationStats;
}

export interface ReconciliationStats {
  readonly bookLines: number;
  readonly statementLines: number;
  readonly matchedPairs: number;
  readonly matchedGroups: number;
  readonly suggestions: number;
  /** Share of statement lines that ended up in a confident match, `0..1`. */
  readonly statementCoverage: number;
  /** Share of ledger movements that ended up in a confident match, `0..1`. */
  readonly bookCoverage: number;
  /** True when every group search finished rather than hitting its budget. */
  readonly groupSearchExhaustive: boolean;
}

function withinDays(a: CalendarDate, b: CalendarDate, days: number): boolean {
  return Math.abs(daysBetween(a, b)) <= days;
}

interface GroupCandidate {
  readonly bookIndices: readonly number[];
  readonly statementIndices: readonly number[];
  readonly kind: MatchKind;
  readonly scored: ScoredMatch;
}

/**
 * Group candidates in one direction: each anchor line on the "one" side is
 * tested against subsets of the "many" side that fall inside the date window
 * and add up to it.
 */
function gatherGroups(
  books: readonly BookLine[],
  statement: readonly StatementLine[],
  direction: "one-to-many" | "many-to-one",
  options: ReconciliationOptions,
  resolved: ResolvedScoringOptions,
  maxGroupSize: number,
  windowDays: number,
  bookTaken: readonly boolean[],
  statementTaken: readonly boolean[],
): { candidates: GroupCandidate[]; exhaustive: boolean } {
  const candidates: GroupCandidate[] = [];
  let exhaustive = true;

  // "one-to-many": one statement line explained by several ledger movements.
  const statementItems = statement
    .map((line, index) => ({ date: line.date, minorUnits: line.amount.minorUnits, index }))
    .filter((item) => statementTaken[item.index] !== true);
  const bookItems = books
    .map((book, index) => ({ date: book.date, minorUnits: book.amount.minorUnits, index }))
    .filter((item) => bookTaken[item.index] !== true);

  const anchors = direction === "one-to-many" ? statementItems : bookItems;
  const pool = direction === "one-to-many" ? bookItems : statementItems;

  for (const anchor of anchors) {
    const nearby = pool.filter((item) => withinDays(item.date, anchor.date, windowDays));
    if (nearby.length < 2) continue;

    const search = findSubsets(
      nearby.map((item) => item.minorUnits),
      anchor.minorUnits,
      {
        maxSize: maxGroupSize,
        minSize: 1,
        tolerance: resolved.amountToleranceMinorUnits,
        maxResults: 8,
      },
    );
    if (!search.exhaustive) exhaustive = false;

    // If one line on its own already accounts for the anchor, this is not a
    // group at all — it is an ordinary pair, and the one-to-one pass will do
    // a better job of choosing which line. Proposing a group here is how a
    // matcher ends up explaining a £7,200 receipt as an invoice plus two
    // entries that happen to cancel out.
    if (search.subsets.some((subset) => subset.indices.length === 1)) continue;

    for (const subset of search.subsets) {
      if (subset.indices.length < 2) continue;
      const poolIndices = subset.indices.map((i) => (nearby[i] as { index: number }).index);
      const bookIndices = direction === "one-to-many" ? poolIndices : [anchor.index];
      const statementIndices = direction === "one-to-many" ? [anchor.index] : poolIndices;

      // A batch is allowed the wider window for scoring too, not just for
      // gathering: a supplier run spread over a fortnight is one event, and
      // holding it to the same date gate as a single payment would reject it
      // on the very property that makes it a batch.
      const scored = scoreGroup(
        bookIndices.map((i) => books[i] as BookLine),
        statementIndices.map((i) => statement[i] as StatementLine),
        { ...options, dateWindowDays: Math.max(windowDays, resolved.dateWindowDays) },
      );
      if (scored.confidence === "rejected") continue;

      candidates.push(
        Object.freeze({
          bookIndices: Object.freeze([...bookIndices].sort((a, b) => a - b)),
          statementIndices: Object.freeze([...statementIndices].sort((a, b) => a - b)),
          kind: direction,
          scored,
        }),
      );
    }
  }

  return { candidates, exhaustive };
}

/**
 * Reconcile our cash movements against the bank's statement.
 *
 * Neither side is assumed to be right. The result says which lines agree,
 * which look like they might, and which are left over on each side — and the
 * leftovers are the interesting part, because they are the timing differences
 * and the missing entries.
 */
export function reconcile(
  books: readonly BookLine[],
  statement: readonly StatementLine[],
  options: ReconciliationOptions = {},
): ReconciliationResult {
  const resolved = resolveScoringOptions(options);
  const maxGroupSize = Math.max(2, options.maxGroupSize ?? 4);
  const groupWindowDays = options.groupWindowDays ?? 14;
  const groupMatching = options.groupMatching ?? true;

  const bookTaken = new Array<boolean>(books.length).fill(false);
  const statementTaken = new Array<boolean>(statement.length).fill(false);

  const matched: Match[] = [];
  const suggested: Match[] = [];
  let matchedGroups = 0;
  let groupSearchExhaustive = true;

  /**
   * One sweep of group matching over whatever is still free, accepting any
   * candidate at or above `minScore`. Returns the matches it made rather than
   * pushing them, so the caller decides which bucket they land in.
   */
  const groupPass = (minScore: number): Match[] => {
    if (!groupMatching || books.length === 0 || statement.length === 0) return [];

    const oneToMany = gatherGroups(
      books,
      statement,
      "one-to-many",
      options,
      resolved,
      maxGroupSize,
      groupWindowDays,
      bookTaken,
      statementTaken,
    );
    const manyToOne = gatherGroups(
      books,
      statement,
      "many-to-one",
      options,
      resolved,
      maxGroupSize,
      groupWindowDays,
      bookTaken,
      statementTaken,
    );
    if (!oneToMany.exhaustive || !manyToOne.exhaustive) groupSearchExhaustive = false;

    // Best first, then narrowest, then by position — a stable order, so the
    // same books and the same statement always reconcile the same way.
    const candidates = [...oneToMany.candidates, ...manyToOne.candidates].sort((a, b) => {
      if (b.scored.score !== a.scored.score) return b.scored.score - a.scored.score;
      const aWidth = a.bookIndices.length + a.statementIndices.length;
      const bWidth = b.bookIndices.length + b.statementIndices.length;
      if (aWidth !== bWidth) return aWidth - bWidth;
      return (a.bookIndices[0] as number) - (b.bookIndices[0] as number);
    });

    const made: Match[] = [];
    for (const candidate of candidates) {
      if (candidate.scored.score < minScore) continue;
      if (candidate.bookIndices.some((i) => bookTaken[i] === true)) continue;
      if (candidate.statementIndices.some((i) => statementTaken[i] === true)) continue;

      for (const i of candidate.bookIndices) bookTaken[i] = true;
      for (const i of candidate.statementIndices) statementTaken[i] = true;
      made.push(
        Object.freeze({
          book: Object.freeze(candidate.bookIndices.map((i) => books[i] as BookLine)),
          statement: Object.freeze(
            candidate.statementIndices.map((i) => statement[i] as StatementLine),
          ),
          kind: candidate.kind,
          scored: candidate.scored,
        }),
      );
    }
    return made;
  };

  // --- pass one: groups we are sure about --------------------------------

  const confidentGroups = groupPass(resolved.autoAcceptScore);
  matchedGroups += confidentGroups.length;
  matched.push(...confidentGroups);

  // --- pass two: one-to-one, solved optimally ----------------------------

  const bookIndices = books.map((_, i) => i).filter((i) => bookTaken[i] !== true);
  const statementIndices = statement.map((_, i) => i).filter((i) => statementTaken[i] !== true);

  const scores = new Map<string, ScoredMatch>();
  const weights: number[][] = bookIndices.map((bookIndex) =>
    statementIndices.map((statementIndex) => {
      const scored = scorePair(
        books[bookIndex] as BookLine,
        statement[statementIndex] as StatementLine,
        options,
      );
      scores.set(`${bookIndex}:${statementIndex}`, scored);
      return scored.rejectedBy !== null || scored.score < resolved.suggestScore
        ? Number.NEGATIVE_INFINITY
        : scored.score;
    }),
  );

  const assignment = maximumWeightMatching(weights, { threshold: resolved.suggestScore });

  for (const pair of assignment.pairs) {
    const bookIndex = bookIndices[pair.row] as number;
    const statementIndex = statementIndices[pair.col] as number;
    const scored = scores.get(`${bookIndex}:${statementIndex}`) as ScoredMatch;

    const match: Match = Object.freeze({
      book: Object.freeze([books[bookIndex] as BookLine]),
      statement: Object.freeze([statement[statementIndex] as StatementLine]),
      kind: "one-to-one" as const,
      scored,
    });

    bookTaken[bookIndex] = true;
    statementTaken[statementIndex] = true;
    if (scored.score >= resolved.autoAcceptScore) matched.push(match);
    else suggested.push(match);
  }

  // --- pass three: groups worth a look ------------------------------------
  //
  // A batch payment whose bank descriptor says nothing useful ("BACS SUPPLIER
  // RUN 100926") will never clear the auto-accept bar on wording alone, but
  // four invoices that add up to the penny on the same day is exactly the kind
  // of thing a reviewer should see. This pass runs last, over lines that found
  // nothing at all, so a speculative group can never displace a real pair.

  const speculativeGroups = groupPass(resolved.suggestScore);
  suggested.push(...speculativeGroups);

  matched.sort((a, b) => compareByFirstDate(a, b));
  suggested.sort((a, b) => b.scored.score - a.scored.score || compareByFirstDate(a, b));

  const unmatchedBook = books.filter((_, i) => bookTaken[i] !== true);
  const unmatchedStatement = statement.filter((_, i) => statementTaken[i] !== true);

  const matchedBookCount = matched.reduce((sum, match) => sum + match.book.length, 0);
  const matchedStatementCount = matched.reduce((sum, match) => sum + match.statement.length, 0);

  return Object.freeze({
    matched: Object.freeze(matched),
    suggested: Object.freeze(suggested),
    unmatchedBook: Object.freeze(unmatchedBook),
    unmatchedStatement: Object.freeze(unmatchedStatement),
    options: resolved,
    stats: Object.freeze({
      bookLines: books.length,
      statementLines: statement.length,
      matchedPairs: matched.filter((m) => m.kind === "one-to-one").length,
      matchedGroups,
      suggestions: suggested.length,
      statementCoverage:
        statement.length === 0 ? 1 : matchedStatementCount / statement.length,
      bookCoverage: books.length === 0 ? 1 : matchedBookCount / books.length,
      groupSearchExhaustive,
    }),
  });
}

function compareByFirstDate(a: Match, b: Match): number {
  const aDate = a.statement[0]?.date ?? a.book[0]?.date ?? "";
  const bDate = b.statement[0]?.date ?? b.book[0]?.date ?? "";
  if (aDate !== bDate) return aDate < bDate ? -1 : 1;
  const aId = a.book[0]?.id ?? "";
  const bId = b.book[0]?.id ?? "";
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/** Every line in a match, rendered as one line of text. */
export function describeMatch(match: Match): string {
  const books = match.book.map((b) => `${b.date} ${b.amount.toDecimalString()} ${b.description}`);
  const lines = match.statement.map(
    (l) => `${l.date} ${l.amount.toDecimalString()} ${l.description}`,
  );
  return `${books.join(" + ")}  <->  ${lines.join(" + ")}`;
}

/** The reasons that actually carried weight, best first. */
export function significantReasons(match: Match): readonly string[] {
  return match.scored.reasons
    .filter((reason) => reason.weight > 0)
    .sort((a, b) => b.contribution - a.contribution)
    .map((reason) => `${reason.rule}: ${reason.detail}`);
}
