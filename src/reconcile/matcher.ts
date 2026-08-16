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
import { maximumWeightMatchingSparse, type WeightedEdge } from "./assignment.js";
import { CandidateIndex } from "./candidates.js";
import { toEpochDay } from "../ledger/date.js";

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
  /**
   * Pairs that got as far as being scored in the one-to-one pass.
   *
   * The interesting number is how it compares to `bookLines * statementLines`:
   * everything else is a pair the amount-and-date index ruled out before the
   * expensive text comparison ran.
   */
  readonly pairsScored: number;
}

interface PoolItem {
  readonly date: CalendarDate;
  readonly epochDay: number;
  readonly minorUnits: bigint;
  readonly index: number;
}

/** First position in a day-sorted pool at or after `day`. */
function firstAtOrAfter(pool: readonly PoolItem[], day: number): number {
  let low = 0;
  let high = pool.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((pool[mid] as PoolItem).epochDay < day) low = mid + 1;
    else high = mid;
  }
  return low;
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
  const statementItems: PoolItem[] = statement
    .map((line, index) => ({
      date: line.date,
      epochDay: toEpochDay(line.date),
      minorUnits: line.amount.minorUnits,
      index,
    }))
    .filter((item) => statementTaken[item.index] !== true);
  const bookItems: PoolItem[] = books
    .map((book, index) => ({
      date: book.date,
      epochDay: toEpochDay(book.date),
      minorUnits: book.amount.minorUnits,
      index,
    }))
    .filter((item) => bookTaken[item.index] !== true);

  const anchors = direction === "one-to-many" ? statementItems : bookItems;
  const pool = direction === "one-to-many" ? bookItems : statementItems;

  // Sorted once by day so each anchor's window is a slice found by binary
  // search. Re-filtering the whole pool per anchor is quadratic before the
  // subset search — which is the expensive part — has even started.
  const byDay = [...pool].sort((a, b) => a.epochDay - b.epochDay || a.index - b.index);

  for (const anchor of anchors) {
    const anchorSign = anchor.minorUnits > 0n ? 1 : anchor.minorUnits < 0n ? -1 : 0;
    const start = firstAtOrAfter(byDay, anchor.epochDay - windowDays);
    const nearby: PoolItem[] = [];
    for (let i = start; i < byDay.length; i++) {
      const item = byDay[i] as PoolItem;
      if (item.epochDay > anchor.epochDay + windowDays) break;
      // Only movements going the same way as the anchor. A supplier run is all
      // outflows and a lump-sum receipt is all inflows; a "group" that mixes
      // the two is money in and money out that happen to cancel, which is the
      // artefact the direction gate exists to refuse.
      //
      // It also makes the search affordable. Subset-sum prunes on how much the
      // remaining values could still contribute, and with both signs in the
      // pool that band spans everything from the sum of all the debits to the
      // sum of all the credits, so no branch can ever be ruled out. Same-sign
      // values give a one-sided bound that kills whole subtrees at once.
      const itemSign = item.minorUnits > 0n ? 1 : item.minorUnits < 0n ? -1 : 0;
      if (anchorSign !== 0 && itemSign !== 0 && itemSign !== anchorSign) continue;
      nearby.push(item);
    }
    // The window slice comes out in day order; the subset search and the
    // scoring below both index into it, so put it back in input order to keep
    // the answer identical to the sweep this replaced.
    nearby.sort((a, b) => a.index - b.index);
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

  // Amount, currency, sign and date are gates in the scorer: a pair failing any
  // of them is rejected before its descriptions are ever compared. So they are
  // asked of an index first, and only what survives gets scored. On real books
  // that is a fraction of a percent of the cross product, and what is left is a
  // sparse graph the solver can decompose instead of one dense matrix.
  const pairIndex = new CandidateIndex(books);
  const scores = new Map<string, ScoredMatch>();
  const edges: WeightedEdge[] = [];
  let pairsScored = 0;

  statement.forEach((line, statementIndex) => {
    if (statementTaken[statementIndex] === true) return;
    const candidates = pairIndex.candidatesFor(
      line,
      resolved.amountToleranceMinorUnits,
      resolved.dateWindowDays,
    );
    for (const bookIndex of candidates) {
      if (bookTaken[bookIndex] === true) continue;
      const scored = scorePair(books[bookIndex] as BookLine, line, options);
      pairsScored += 1;
      scores.set(`${bookIndex}:${statementIndex}`, scored);
      if (scored.rejectedBy !== null || scored.score < resolved.suggestScore) continue;
      edges.push({ row: bookIndex, col: statementIndex, weight: scored.score });
    }
  });

  const assignment = maximumWeightMatchingSparse(edges, books.length, statement.length, {
    threshold: resolved.suggestScore,
  });

  for (const pair of assignment.pairs) {
    const bookIndex = pair.row;
    const statementIndex = pair.col;
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
      pairsScored,
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
