/**
 * How good is this match, and why?
 *
 * The "why" is not decoration. A reconciliation engine that emits a number and
 * nothing else leaves a reviewer with two options: trust it blindly, or redo
 * the work by hand. So every score comes with the rules that produced it, each
 * carrying its own sub-score and how much it moved the total.
 *
 * Two of the rules are gates rather than contributions. A payment that differs
 * by £40 is not a weak match, it is a different transaction; money in and money
 * out are not a near miss. Both reject outright, and the caller is told which
 * gate closed. The remaining rules — date proximity, description similarity,
 * shared references — are weighted and averaged.
 *
 * The reference rule is dropped from the average when neither side carries a
 * reference at all. Scoring a missing signal as zero would punish every cash
 * transaction in the book for something it could never have had.
 */

import { Money } from "../money/money.js";
import type { CalendarDate } from "../ledger/date.js";
import { daysBetween } from "../ledger/date.js";
import type { StatementLine } from "../statement/line.js";
import type { BookLine } from "./bankView.js";
import { similarityBreakdown } from "./similarity.js";
import type { MatchMemory } from "./memory.js";

export type RuleName = "amount" | "direction" | "date" | "description" | "reference" | "memory";

export interface MatchReason {
  readonly rule: RuleName;
  /** Human-readable, and meant to be read: this is what the reviewer sees. */
  readonly detail: string;
  /** This rule's own verdict, `0..1`. */
  readonly score: number;
  /** Its weight in the average; `0` for a rule that did not apply. */
  readonly weight: number;
  /** `score * weight`, before normalisation. */
  readonly contribution: number;
}

export type Confidence = "exact" | "high" | "medium" | "low" | "rejected";

export interface ScoredMatch {
  readonly score: number;
  readonly confidence: Confidence;
  readonly reasons: readonly MatchReason[];
  /** Set when a gate rejected the pair outright. */
  readonly rejectedBy: RuleName | null;
  /** Statement date minus book date, in days. */
  readonly dayGap: number;
  /** Statement amount minus book amount, in minor units. */
  readonly amountGap: bigint;
}

export interface ScoringWeights {
  readonly amount: number;
  readonly date: number;
  readonly description: number;
  readonly reference: number;
  readonly memory: number;
}

export interface ScoringOptions {
  /** Beyond this many days apart, a pair is rejected. Default 7. */
  dateWindowDays?: number;
  /** Amounts may differ by at most this many minor units. Default 0. */
  amountToleranceMinorUnits?: bigint;
  weights?: Partial<ScoringWeights>;
  /** Score at or above which a match is safe to post unreviewed. Default 0.86. */
  autoAcceptScore?: number;
  /** Score below which a pair is not worth showing at all. Default 0.45. */
  suggestScore?: number;
  /**
   * What a reviewer has already confirmed or refused. Omit it and the memory
   * rule never applies, and scoring is exactly what it was before memory
   * existed.
   */
  memory?: MatchMemory;
}

export interface ResolvedScoringOptions {
  readonly dateWindowDays: number;
  readonly amountToleranceMinorUnits: bigint;
  readonly weights: ScoringWeights;
  readonly autoAcceptScore: number;
  readonly suggestScore: number;
  readonly memory: MatchMemory | undefined;
}

/**
 * Amount and date carry most of the weight, and deliberately so. A bank
 * descriptor and a narration are written by different people for different
 * purposes; agreeing on the penny and the day is much stronger evidence than
 * agreeing on the wording, and description is best used to break ties between
 * candidates that already agree on the numbers.
 */
export const DEFAULT_WEIGHTS: ScoringWeights = Object.freeze({
  amount: 0.3,
  date: 0.25,
  description: 0.3,
  reference: 0.15,
  // Level with description, and for a reason that is worth stating: a reviewer
  // confirming a counterparty is a person asserting the identity the
  // description rule is guessing at, so it should not count for less than the
  // guess. It is deliberately not higher. Memory is evidence about *who*, not
  // about *which transaction* — two payments to the same supplier in one week
  // are remembered equally well — so it lifts a pair the numbers already agree
  // on over the auto-accept line and cannot carry one there on its own.
  memory: 0.3,
});

export function resolveScoringOptions(options: ScoringOptions = {}): ResolvedScoringOptions {
  return Object.freeze({
    dateWindowDays: options.dateWindowDays ?? 7,
    amountToleranceMinorUnits: options.amountToleranceMinorUnits ?? 0n,
    weights: Object.freeze({ ...DEFAULT_WEIGHTS, ...(options.weights ?? {}) }),
    autoAcceptScore: options.autoAcceptScore ?? 0.86,
    suggestScore: options.suggestScore ?? 0.45,
    memory: options.memory,
  });
}

const abs = (value: bigint): bigint => (value < 0n ? -value : value);

function formatMinor(minorUnits: bigint, amount: Money): string {
  return Money.ofMinor(minorUnits, amount.currency).toDecimalString();
}

/**
 * Date proximity, decaying to zero at the edge of the window.
 *
 * The decay is quadratic rather than linear because settlement lag clusters
 * hard at nought to two days: a three-day gap is much more suspicious than
 * three times a one-day gap.
 */
function dateScore(gap: number, windowDays: number): number {
  const distance = Math.abs(gap);
  if (distance === 0) return 1;
  if (windowDays <= 0) return 0;
  const fraction = distance / windowDays;
  if (fraction >= 1) return 0;
  return (1 - fraction) ** 2;
}

interface Sides {
  readonly bookAmount: Money;
  readonly bookDate: CalendarDate;
  readonly bookDescription: string;
  /** Description with card noise, prefixes and baked-in dates stripped. */
  readonly bookNormalised: string;
  readonly bookReference: string | null;
  readonly statementAmount: Money;
  readonly statementDate: CalendarDate;
  readonly statementDescription: string;
  readonly statementNormalised: string;
  readonly statementReference: string | null;
}

function reject(
  rule: RuleName,
  detail: string,
  reasons: MatchReason[],
  dayGap: number,
  amountGap: bigint,
): ScoredMatch {
  return Object.freeze({
    score: 0,
    confidence: "rejected" as const,
    reasons: Object.freeze([
      ...reasons,
      Object.freeze({ rule, detail, score: 0, weight: 0, contribution: 0 }),
    ]),
    rejectedBy: rule,
    dayGap,
    amountGap,
  });
}

function scoreSides(sides: Sides, resolved: ResolvedScoringOptions): ScoredMatch {
  const reasons: MatchReason[] = [];

  const sameCurrency = sides.bookAmount.sameCurrency(sides.statementAmount);
  const amountGap = sameCurrency
    ? sides.statementAmount.minorUnits - sides.bookAmount.minorUnits
    : 0n;
  const dayGap = daysBetween(sides.bookDate, sides.statementDate);

  if (!sameCurrency) {
    return reject(
      "amount",
      `${sides.bookAmount.currency.code} in the books against ${sides.statementAmount.currency.code} on the statement`,
      reasons,
      dayGap,
      0n,
    );
  }

  // --- gates -------------------------------------------------------------

  if (abs(amountGap) > resolved.amountToleranceMinorUnits) {
    return reject(
      "amount",
      `off by ${formatMinor(amountGap, sides.bookAmount)}`,
      reasons,
      dayGap,
      amountGap,
    );
  }

  const bookSign = sides.bookAmount.sign;
  const statementSign = sides.statementAmount.sign;
  if (bookSign !== 0 && statementSign !== 0 && bookSign !== statementSign) {
    return reject(
      "direction",
      bookSign === 1 ? "money in against money out" : "money out against money in",
      reasons,
      dayGap,
      amountGap,
    );
  }

  if (Math.abs(dayGap) > resolved.dateWindowDays) {
    return reject(
      "date",
      `${Math.abs(dayGap)} days apart, outside the ${resolved.dateWindowDays} day window`,
      reasons,
      dayGap,
      amountGap,
    );
  }

  const tolerance = resolved.amountToleranceMinorUnits;
  const amountRuleScore =
    amountGap === 0n || tolerance === 0n
      ? 1
      : 1 - Number(abs(amountGap)) / Number(tolerance) / 2;
  reasons.push(
    Object.freeze({
      rule: "amount" as const,
      detail:
        amountGap === 0n
          ? `exact at ${sides.statementAmount.toDecimalString()}`
          : `within tolerance, off by ${formatMinor(amountGap, sides.bookAmount)}`,
      score: amountRuleScore,
      weight: resolved.weights.amount,
      contribution: amountRuleScore * resolved.weights.amount,
    }),
  );

  // --- weighted rules ----------------------------------------------------

  const dateRuleScore = dateScore(dayGap, resolved.dateWindowDays);
  reasons.push(
    Object.freeze({
      rule: "date" as const,
      detail:
        dayGap === 0
          ? "same day"
          : `${Math.abs(dayGap)} day${Math.abs(dayGap) === 1 ? "" : "s"} ${dayGap > 0 ? "later" : "earlier"} on the statement`,
      score: dateRuleScore,
      weight: resolved.weights.date,
      contribution: dateRuleScore * resolved.weights.date,
    }),
  );

  // Compared on the normalised forms: "DD RENT, AUGUST 08" and "August rent"
  // are the same event, and only the normalised text makes that visible.
  const similarity = similarityBreakdown(sides.bookNormalised, sides.statementNormalised);
  reasons.push(
    Object.freeze({
      rule: "description" as const,
      detail:
        similarity.sharedTokens.length > 0
          ? `shares ${similarity.sharedTokens.join(", ")}`
          : `little in common ("${sides.bookNormalised}" / "${sides.statementNormalised}")`,
      score: similarity.score,
      weight: resolved.weights.description,
      contribution: similarity.score * resolved.weights.description,
    }),
  );

  const bookReferenceText = `${sides.bookDescription} ${sides.bookReference ?? ""}`;
  const statementReferenceText = `${sides.statementDescription} ${sides.statementReference ?? ""}`;
  const shared = sharedReferenceList(bookReferenceText, statementReferenceText);
  const eitherHasReference =
    hasReference(bookReferenceText) || hasReference(statementReferenceText);

  if (eitherHasReference) {
    const referenceScore = shared.length > 0 ? 1 : 0;
    reasons.push(
      Object.freeze({
        rule: "reference" as const,
        detail: shared.length > 0 ? `reference ${shared.join(", ")}` : "references disagree",
        score: referenceScore,
        weight: resolved.weights.reference,
        contribution: referenceScore * resolved.weights.reference,
      }),
    );
  } else {
    reasons.push(
      Object.freeze({
        rule: "reference" as const,
        detail: "neither side carries a reference",
        score: 0,
        weight: 0,
        contribution: 0,
      }),
    );
  }

  // --- what the reviewer already told us ---------------------------------
  //
  // Weighted only when there is something to say. A pair involving a
  // counterparty nobody has ever ruled on should score exactly as it did before
  // memory existed, so an absent memory contributes nothing and is not averaged
  // in — the same treatment the reference rule gets when neither side carries
  // one.

  const memoryVerdict = resolved.memory?.recall(
    sides.statementDescription,
    sides.bookDescription,
  );
  const remembered = memoryVerdict !== undefined && memoryVerdict.kind !== "unknown";

  reasons.push(
    Object.freeze({
      rule: "memory" as const,
      detail: memoryVerdict?.detail ?? "nothing remembered about this counterparty",
      score: memoryVerdict?.score ?? 0,
      weight: remembered ? resolved.weights.memory : 0,
      contribution: remembered ? (memoryVerdict?.score ?? 0) * resolved.weights.memory : 0,
    }),
  );

  const totalWeight = reasons.reduce((sum, reason) => sum + reason.weight, 0);
  const averaged =
    totalWeight === 0 ? 0 : reasons.reduce((sum, reason) => sum + reason.contribution, 0) / totalWeight;

  const referenceHit = shared.length > 0;

  // A reviewer who has already refused this pairing outranks the evidence that
  // would otherwise call it exact. Without this the floor below would restore
  // the score to 0.95 and the refusal would have changed nothing, which is the
  // one outcome guaranteed to make somebody stop using the review queue.
  const vetoed = memoryVerdict?.kind === "rejected" || memoryVerdict?.kind === "contradicted";
  const exact =
    !vetoed && amountGap === 0n && dayGap === 0 && (referenceHit || similarity.score >= 0.9);

  // Same penny, same day, and an external reference both sides agree on is
  // about as good as reconciliation evidence gets. When all three line up the
  // wording cannot drag the score down; a bank that writes "SQ *SETTLEMENT
  // 0805" where we wrote "Processor settlement" has still told us enough.
  const score = exact ? Math.max(averaged, 0.95) : averaged;

  let confidence: Confidence;
  if (exact) confidence = "exact";
  else if (score >= resolved.autoAcceptScore) confidence = "high";
  else if (score >= (resolved.autoAcceptScore + resolved.suggestScore) / 2) confidence = "medium";
  else if (score >= resolved.suggestScore) confidence = "low";
  else confidence = "rejected";

  return Object.freeze({
    score,
    confidence,
    reasons: Object.freeze(reasons),
    rejectedBy: null,
    dayGap,
    amountGap,
  });
}

function hasReference(text: string): boolean {
  return /(?:^|[^A-Za-z0-9])[A-Za-z]*\d{3,}/.test(text);
}

function sharedReferenceList(left: string, right: string): string[] {
  return similarityBreakdown(left, right).sharedReferences as string[];
}

/** Score one ledger movement against one statement line. */
export function scorePair(
  book: BookLine,
  line: StatementLine,
  options: ScoringOptions = {},
): ScoredMatch {
  return scoreSides(
    {
      bookAmount: book.amount,
      bookDate: book.date,
      bookDescription: book.description,
      bookNormalised: book.normalisedDescription,
      bookReference: book.reference,
      statementAmount: line.amount,
      statementDate: line.date,
      statementDescription: line.description,
      statementNormalised: line.normalisedDescription,
      statementReference: line.reference,
    },
    resolveScoringOptions(options),
  );
}

/**
 * Score a group: several ledger movements against several statement lines.
 *
 * The group is collapsed to its total, its earliest date, and its descriptions
 * joined, then scored as though it were a single pair. Joining the text is the
 * right move rather than a shortcut — a batch payment's bank descriptor often
 * names one of the invoices in it, and the token-set similarity finds that
 * inside the joined string.
 */
export function scoreGroup(
  books: readonly BookLine[],
  lines: readonly StatementLine[],
  options: ScoringOptions = {},
): ScoredMatch {
  if (books.length === 0 || lines.length === 0) {
    return Object.freeze({
      score: 0,
      confidence: "rejected" as const,
      reasons: Object.freeze([
        Object.freeze({
          rule: "amount" as const,
          detail: "a group needs at least one line on each side",
          score: 0,
          weight: 0,
          contribution: 0,
        }),
      ]),
      rejectedBy: "amount" as const,
      dayGap: 0,
      amountGap: 0n,
    });
  }

  const resolved = resolveScoringOptions(options);
  const bookCurrency = (books[0] as BookLine).amount.currency;
  const lineCurrency = (lines[0] as StatementLine).amount.currency;

  const bookTotal = books.reduce(
    (sum, book) => sum + book.amount.minorUnits,
    0n,
  );
  const lineTotal = lines.reduce((sum, line) => sum + line.amount.minorUnits, 0n);

  const earliest = (values: readonly CalendarDate[]): CalendarDate =>
    values.reduce((min, value) => (value < min ? value : min));

  const scored = scoreSides(
    {
      bookAmount: Money.ofMinor(bookTotal, bookCurrency),
      bookDate: earliest(books.map((b) => b.date)),
      bookDescription: books.map((b) => b.description).join(" "),
      bookNormalised: books.map((b) => b.normalisedDescription).join(" "),
      bookReference: books.map((b) => b.reference).filter((r) => r !== null).join(" ") || null,
      statementAmount: Money.ofMinor(lineTotal, lineCurrency),
      statementDate: earliest(lines.map((l) => l.date)),
      statementDescription: lines.map((l) => l.description).join(" "),
      statementNormalised: lines.map((l) => l.normalisedDescription).join(" "),
      statementReference: lines.map((l) => l.reference).filter((r) => r !== null).join(" ") || null,
    },
    resolved,
  );

  if (scored.rejectedBy !== null) return scored;

  // A group is a weaker claim than a pair — there are more ways to be
  // accidentally right — so the wider it is, the more the score is discounted.
  const width = books.length + lines.length;
  const penalty = 1 - Math.min(0.18, 0.045 * (width - 2));
  const score = scored.score * penalty;

  const reasons: MatchReason[] = [
    ...scored.reasons,
    Object.freeze({
      rule: "amount" as const,
      detail: `${books.length} ledger ${books.length === 1 ? "entry" : "entries"} against ${lines.length} statement ${lines.length === 1 ? "line" : "lines"}`,
      score: penalty,
      weight: 0,
      contribution: 0,
    }),
  ];

  let confidence: Confidence = scored.confidence;
  if (confidence === "exact") confidence = "high";
  if (score < resolved.suggestScore) confidence = "rejected";
  else if (score < (resolved.autoAcceptScore + resolved.suggestScore) / 2 && confidence !== "low") {
    confidence = "low";
  }

  return Object.freeze({
    score,
    confidence,
    reasons: Object.freeze(reasons),
    rejectedBy: null,
    dayGap: scored.dayGap,
    amountGap: scored.amountGap,
  });
}
