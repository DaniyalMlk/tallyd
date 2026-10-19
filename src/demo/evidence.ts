/**
 * The figures on the front page, computed rather than remembered.
 *
 * A reconciliation engine is easy to describe and hard to believe. Every one
 * of them claims to match a bank statement against a set of books; the
 * question a reader actually has is how often it is right, how often it is
 * wrong, and what happens to the lines it cannot explain. Prose cannot answer
 * that, so this module answers it with numbers and the README quotes them.
 *
 * Three things make the numbers worth quoting:
 *
 * 1. The generator in `./generator.ts` builds books *with the answer key*, so
 *    the matcher can be scored against truth rather than against its own
 *    opinion of itself. `measureAccuracy` does the scoring.
 * 2. The index figure is a count, not a duration. "Fast" measured in
 *    milliseconds is a statement about the machine it ran on; the number of
 *    candidate pairs the amount-and-date index lets through is a property of
 *    the algorithm and is the same everywhere.
 * 3. Money is exact. Every amount is an integer number of minor units, so a
 *    trial balance that balances does not balance to within a tolerance, it
 *    balances. The consolidation row is there because that is the place where
 *    a rounding plug would otherwise hide.
 *
 * Each section checks itself and `report()` throws if a figure moves outside
 * the band the README promises, so `npm run demo:evidence` is a gate and not
 * a printout.
 */

import { generateBooks } from "./generator.js";
import {
  checkUnrealised,
  unrealisedEvidence,
  unrealisedRows,
  type UnrealisedEvidence,
} from "./unrealisedEvidence.js";
import { consolidatedGroup } from "./groupReport.js";
import { bankView } from "../reconcile/bankView.js";
import { reconcile, type Match } from "../reconcile/matcher.js";
import { measureAccuracy, type AccuracyReport } from "../reconcile/accuracy.js";
import { MatchMemory, type Decision } from "../reconcile/memory.js";
import { trialBalance } from "../ledger/index.js";
import type { CalendarDate } from "../ledger/date.js";

/** Truth links, in the shape `measureAccuracy` and this module both want. */
interface TruthLink {
  readonly statementId: string;
  readonly bookIds: readonly string[];
}

/** One reconciled window of generated books, scored against its answer key. */
interface Window {
  readonly bookLines: number;
  readonly statementLines: number;
  readonly pairsScored: number;
  readonly queue: number;
  readonly accuracy: AccuracyReport;
  readonly truth: readonly TruthLink[];
  readonly matched: readonly Match[];
  readonly suggested: readonly Match[];
  readonly through: CalendarDate;
}

/**
 * Generate a window of books, reconcile it, and score the result.
 *
 * Everything the report quotes comes through here, which is the point: a
 * figure measured by a one-off script and then pinned in a test that builds
 * its sample a different way is a figure that does not reproduce.
 */
function reconcileWindow(
  seed: number,
  months: number,
  invoicesPerMonth: number,
  start: string,
  memory?: MatchMemory,
): Window {
  const generated = generateBooks({ seed, months, invoicesPerMonth, start });
  const books = bankView(generated.ledger, generated.bankAccount);
  const result = reconcile(
    books,
    generated.statement,
    memory === undefined ? {} : { memory },
  );
  return {
    bookLines: books.length,
    statementLines: generated.statement.length,
    pairsScored: result.stats.pairsScored,
    queue: result.suggested.length,
    accuracy: measureAccuracy(result, generated.truth),
    truth: generated.truth,
    matched: result.matched,
    suggested: result.suggested,
    through: generated.to,
  };
}

/**
 * The decisions a reviewer working through a queue would leave behind.
 *
 * One per pair they looked at, accepted when the pairing was in fact right.
 * That is the optimistic-but-fair assumption — a reviewer who cannot tell
 * their own suppliers apart is not a problem the matcher can fix — and it is
 * the same assumption `tests/memoryLearning.test.ts` makes.
 */
function decisionsFrom(
  matches: readonly Match[],
  truth: readonly TruthLink[],
  on: CalendarDate,
): Decision[] {
  const expected = new Map(
    truth.map((link) => [link.statementId, [...link.bookIds].sort().join("+")]),
  );

  return matches
    .filter((match) => match.statement.length === 1 && match.book.length === 1)
    .map((match) => {
      const statement = match.statement[0];
      const entry = match.book[0];
      if (statement === undefined || entry === undefined) {
        throw new Error("a match with no lines in it");
      }
      return {
        statementDescription: statement.description,
        bookDescription: entry.description,
        accepted: expected.get(statement.id) === entry.id,
        on,
      };
    });
}

/** What the accuracy sweep found, across every seed it tried. */
export interface AccuracySweep {
  readonly seeds: number;
  readonly links: number;
  readonly wrong: number;
  readonly worstPrecision: number;
  readonly worstRecall: number;
  readonly worstRecallWithSuggestions: number;
}

/**
 * Score the matcher against twenty unrelated sets of generated books.
 *
 * One seed proves nothing: a matcher tuned on a single dataset scores well on
 * it by construction. Twenty is enough that the worst case is worth quoting,
 * and the worst case is what is quoted — a mean would hide the period where
 * it did badly, which is the period a reader cares about.
 */
export function accuracySweep(seeds = 20): AccuracySweep {
  let links = 0;
  let wrong = 0;
  let worstPrecision = 1;
  let worstRecall = 1;
  let worstRecallWithSuggestions = 1;

  for (let seed = 1; seed <= seeds; seed++) {
    const { accuracy } = reconcileWindow(seed, 4, 12, "2026-01-01");
    links += accuracy.expected;
    wrong += accuracy.wrong;
    worstPrecision = Math.min(worstPrecision, accuracy.precision);
    worstRecall = Math.min(worstRecall, accuracy.recall);
    worstRecallWithSuggestions = Math.min(
      worstRecallWithSuggestions,
      accuracy.recallWithSuggestions,
    );
  }

  return { seeds, links, wrong, worstPrecision, worstRecall, worstRecallWithSuggestions };
}

/** One size of book, and how much of the dense pair space it had to look at. */
export interface IndexPoint {
  readonly bookLines: number;
  readonly statementLines: number;
  readonly dense: number;
  readonly pairsScored: number;
  readonly ratio: number;
  readonly precision: number;
}

/**
 * How much work the amount-and-date index avoids, at three sizes.
 *
 * The honest comparison is against `bookLines * statementLines`, which is
 * what a matcher that scored every pair would do. Text similarity is the
 * expensive part of scoring a pair, so the pairs that never reach it are the
 * whole of the performance story, and counting them says the same thing on
 * every machine.
 */
export function indexSelectivity(): readonly IndexPoint[] {
  const sizes: readonly (readonly [number, number])[] = [
    [12, 12],
    [12, 40],
    [12, 60],
  ];

  return sizes.map(([months, invoicesPerMonth]) => {
    const window = reconcileWindow(11, months, invoicesPerMonth, "2026-01-01");
    const dense = window.bookLines * window.statementLines;
    return {
      bookLines: window.bookLines,
      statementLines: window.statementLines,
      dense,
      pairsScored: window.pairsScored,
      ratio: dense / window.pairsScored,
      precision: window.accuracy.precision,
    };
  });
}

/** The same books reconciled twice: once cold, once with a month's memory. */
export interface LearningEffect {
  readonly remembered: number;
  readonly coldRecall: number;
  readonly warmRecall: number;
  readonly coldQueue: number;
  readonly warmQueue: number;
  readonly queueReduction: number;
  readonly coldPrecision: number;
  readonly warmPrecision: number;
}

/**
 * What a period's review decisions are worth in the period after it.
 *
 * Two different sets of books from the same business: unrelated transactions,
 * because the seeds differ, against the same cast of customers and suppliers,
 * which is the situation a counterparty memory exists for. The first period's
 * queue is worked through, and the second is reconciled with and without what
 * that left behind.
 */
export function learningEffect(): LearningEffect {
  const train = reconcileWindow(5, 4, 12, "2026-01-01");
  const memory = MatchMemory.from([
    ...decisionsFrom(train.matched, train.truth, train.through),
    ...decisionsFrom(train.suggested, train.truth, train.through),
  ]);

  const cold = reconcileWindow(6, 4, 12, "2027-01-01");
  const warm = reconcileWindow(6, 4, 12, "2027-01-01", memory);

  return {
    remembered: memory.size,
    coldRecall: cold.accuracy.recall,
    warmRecall: warm.accuracy.recall,
    coldQueue: cold.queue,
    warmQueue: warm.queue,
    queueReduction: 1 - warm.queue / cold.queue,
    coldPrecision: cold.accuracy.precision,
    warmPrecision: warm.accuracy.precision,
  };
}

/** The two places an inexact amount would show up, and what they report. */
export interface ExactArithmetic {
  readonly entries: number;
  readonly trialBalanceDebit: string;
  readonly trialBalanceCredit: string;
  readonly trialBalanceDifference: string;
  readonly groupEntries: number;
  readonly groupDifference: string;
  readonly translationAdjustment: string;
  readonly translationReserve: string;
  readonly groupResidual: string;
  readonly groupBalanced: boolean;
}

/**
 * The exactness claim, measured where it would fail if it were false.
 *
 * Amounts are integer minor units, so a trial balance either balances or it
 * does not; there is no tolerance to choose. The interesting case is the
 * consolidation, because three companies kept in three currencies have to be
 * translated at different rates and the difference has to land *somewhere*.
 * It lands in the translation reserve, and the reserve is the adjustment with
 * its sign flipped rather than whatever was needed to make the page add up.
 */
export function exactArithmetic(): ExactArithmetic {
  const generated = generateBooks({
    seed: 11,
    months: 12,
    invoicesPerMonth: 12,
    start: "2026-01-01",
  });
  const balance = trialBalance(generated.ledger);
  const group = consolidatedGroup();

  return {
    entries: generated.ledger.size,
    trialBalanceDebit: balance.totalDebit.toString(),
    trialBalanceCredit: balance.totalCredit.toString(),
    trialBalanceDifference: balance.difference.toString(),
    groupEntries: group.ledger.size,
    groupDifference: group.trialBalance.difference.toString(),
    translationAdjustment: group.aggregation.translationAdjustment.toString(),
    translationReserve: group.translationReserve.toString(),
    groupResidual: group.residual.toString(),
    groupBalanced: group.balanced,
  };
}

/** Everything the front page quotes, in one object. */
export interface Evidence {
  readonly accuracy: AccuracySweep;
  readonly index: readonly IndexPoint[];
  readonly learning: LearningEffect;
  readonly unrealised: UnrealisedEvidence;
  readonly exact: ExactArithmetic;
}

/** A percentage, to one decimal place, the way the README writes them. */
function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** An integer with thousands separators, the way the README writes them. */
function thousands(value: number): string {
  return value.toLocaleString("en-GB");
}

/**
 * Measure everything, checking each figure against the band the README states.
 *
 * The thresholds here are the claims, so they are deliberately the weakest
 * form of each claim that is still worth making: zero wrong matches is not a
 * band at all, and the rest are round numbers below what was measured. A
 * change that makes the engine worse in a way a reader would mind trips one
 * of these; a change that moves a figure in the third decimal place does not.
 */
export function evidence(): Evidence {
  const accuracy = accuracySweep();
  if (accuracy.wrong !== 0) {
    throw new Error(
      `the matcher made ${accuracy.wrong} wrong matches across ` +
        `${accuracy.seeds} periods; the README claims none`,
    );
  }
  if (accuracy.worstPrecision !== 1) {
    throw new Error(`worst precision ${accuracy.worstPrecision}, not 1`);
  }
  if (accuracy.worstRecall < 0.6) {
    throw new Error(`worst recall ${accuracy.worstRecall}, under 0.6`);
  }
  if (accuracy.worstRecallWithSuggestions < 0.9) {
    throw new Error(
      `worst recall with suggestions ${accuracy.worstRecallWithSuggestions}, under 0.9`,
    );
  }

  const index = indexSelectivity();
  for (const point of index) {
    if (point.ratio < 100) {
      throw new Error(
        `the index scored ${point.pairsScored} of ${point.dense} pairs ` +
          `(${point.ratio.toFixed(1)}x), under the 100x the README claims`,
      );
    }
    if (point.precision !== 1) {
      throw new Error(
        `precision fell to ${point.precision} at ${point.bookLines} movements`,
      );
    }
  }

  const learning = learningEffect();
  if (learning.warmRecall <= learning.coldRecall) {
    throw new Error(
      `memory did not help: ${learning.coldRecall} cold, ${learning.warmRecall} warm`,
    );
  }
  if (learning.warmQueue >= learning.coldQueue) {
    throw new Error(
      `the queue did not shorten: ${learning.coldQueue} cold, ${learning.warmQueue} warm`,
    );
  }
  if (learning.warmPrecision !== 1) {
    throw new Error(
      `memory bought recall with wrong matches: precision ${learning.warmPrecision}`,
    );
  }

  const unrealised = unrealisedEvidence();
  checkUnrealised(unrealised);

  const exact = exactArithmetic();
  for (const [what, difference] of [
    ["the trial balance", exact.trialBalanceDifference],
    ["the consolidated trial balance", exact.groupDifference],
    ["the consolidation", exact.groupResidual],
  ] as const) {
    if (!/^-?0\.00 [A-Z]{3}$/.test(difference)) {
      throw new Error(`${what} is out by ${difference}`);
    }
  }
  if (!exact.groupBalanced) throw new Error("the consolidation does not balance");

  return { accuracy, index, learning, exact, unrealised };
}

/**
 * Render the evidence as the README's table, plus the figures around it.
 *
 * The output is what `tests/readmeEvidence.test.ts` reads: every figure the
 * front page quotes has to appear in this text, which is how a number in the
 * document and a number in the code are kept from drifting apart.
 */
export function evidenceReport(): string {
  const { accuracy, index, learning, exact, unrealised } = evidence();
  const stock = unrealisedRows(unrealised);
  const small = index[0];
  const large = index[index.length - 1];
  if (small === undefined || large === undefined) {
    throw new Error("the index sweep measured nothing");
  }

  const lines: string[] = [];
  const row = (check: string, result: string): void => {
    lines.push(`| ${check} | ${result} |`);
  };

  lines.push("1. What is checked, and against what");
  lines.push("");
  lines.push("| Check | Result |");
  lines.push("| --- | --- |");
  row(
    `The matcher against generated books with an answer key, ${accuracy.seeds} periods`,
    `${thousands(accuracy.links)} links, ${accuracy.wrong} wrong matches, precision ` +
      `${accuracy.worstPrecision.toFixed(3)} in every period`,
  );
  row(
    "The worst of those periods, unattended and then with the review queue",
    `recall ${percent(accuracy.worstRecall)}, ` +
      `${percent(accuracy.worstRecallWithSuggestions)} with suggestions`,
  );
  row(
    "Candidate pairs the amount-and-date index lets through to scoring",
    `${thousands(small.pairsScored)} of ${thousands(small.dense)} ` +
      `(${small.ratio.toFixed(0)}x), ` +
      `${thousands(large.pairsScored)} of ${thousands(large.dense)} ` +
      `(${large.ratio.toFixed(0)}x) at ${thousands(large.bookLines)} movements`,
  );
  row(
    "A counterparty confirmed once, in the next period's unrelated books",
    `recall ${percent(learning.coldRecall)} to ${percent(learning.warmRecall)}, ` +
      `queue ${learning.coldQueue} to ${learning.warmQueue} ` +
      `(${percent(learning.queueReduction)} shorter), precision still ` +
      `${learning.warmPrecision.toFixed(3)}`,
  );
  row(
    `Trial balance over ${exact.entries} generated journal entries`,
    `${exact.trialBalanceDebit} against ${exact.trialBalanceCredit}, ` +
      `difference ${exact.trialBalanceDifference}`,
  );
  row(
    "A three-company, three-currency consolidation",
    `${exact.groupEntries} balanced entries, translation reserve ` +
      `${exact.translationReserve} against an adjustment of ` +
      `${exact.translationAdjustment}, residual ${exact.groupResidual}`,
  );
  row("The same quarter read as a markup on cost and as a margin on price", stock.conventions);
  row(
    "One consignment of intragroup stock, sent up to the parent and then down to the subsidiary",
    stock.attribution,
  );

  lines.push("");
  lines.push("2. The same figures, spelled out");
  lines.push("");
  lines.push(
    `   accuracy: ${accuracy.seeds} periods, ${accuracy.links} truth links, ` +
      `${accuracy.wrong} wrong`,
  );
  lines.push(
    `   worst period: precision ${accuracy.worstPrecision.toFixed(3)}, ` +
      `recall ${percent(accuracy.worstRecall)}, ` +
      `with suggestions ${percent(accuracy.worstRecallWithSuggestions)}`,
  );
  for (const point of index) {
    lines.push(
      `   index: ${point.bookLines} x ${point.statementLines} movements, ` +
        `${point.pairsScored} pairs scored of ${point.dense} ` +
        `(${point.ratio.toFixed(1)}x fewer)`,
    );
  }
  lines.push(
    `   memory: ${learning.remembered} counterparties remembered, ` +
      `recall ${percent(learning.coldRecall)} to ${percent(learning.warmRecall)}, ` +
      `queue ${learning.coldQueue} to ${learning.warmQueue}`,
  );
  lines.push(
    `   exact: trial balance difference ${exact.trialBalanceDifference}, ` +
      `consolidation residual ${exact.groupResidual}`,
  );
  for (const line of stock.spelled) lines.push(line);
  lines.push("");
  lines.push("every figure above is inside the band the README states");

  return lines.join("\n");
}
