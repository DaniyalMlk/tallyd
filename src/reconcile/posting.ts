/**
 * What a reconciliation implies the books are missing.
 *
 * A reconciliation ends with statement lines the ledger has never heard of:
 * the bank charge nobody entered, the interest, the direct debit that was set
 * up two years ago, the card processor's fee. They are not matching failures —
 * there is genuinely nothing to match them against — and the reconciliation
 * will not balance until somebody books them.
 *
 * "Somebody books them" is where the cycle currently breaks. The matcher knows
 * exactly which lines are missing and says nothing about what to do with them,
 * so a person retypes each one into the ledger, guesses the account, and the
 * guess is recorded nowhere. This module makes the guess explicit, attributable
 * to a rule, and repeatable.
 *
 * ## Three deliberate refusals
 *
 * **It proposes; it does not post.** Every proposal carries the statement line
 * it came from, the rule that classified it, and a balanced entry. Applying
 * them is a separate step a caller has to ask for.
 *
 * **It never invents an account.** A line no rule matches is reported as
 * unclassified. Sweeping the remainder into a suspense account the chart does
 * not have is how a chart of accounts rots: the account appears, everything
 * awkward goes in it, and nobody ever empties it. A caller who wants that
 * behaviour names an account that already exists and takes responsibility for
 * it.
 *
 * **Posting the same statement twice is a no-op.** Entry ids are derived from
 * the statement line's fingerprint — its date, amount and normalised
 * description — so the same line always implies the same entry id, and an id
 * already in the ledger is skipped with a reason rather than posted again.
 * Overlapping statement exports are the normal case, not an edge case.
 */

import { Money } from "../money/money.js";
import type { ChartOfAccounts } from "../accounts/chart.js";
import type { Ledger } from "../ledger/ledger.js";
import { JournalEntry } from "../ledger/entry.js";
import type { StatementLine } from "../statement/line.js";
import type { ReconciliationResult } from "./matcher.js";
import type { MatchMemory } from "./memory.js";

/** Which way the money went, from the account holder's point of view. */
export type Direction = "in" | "out" | "either";

/**
 * A test against a statement line's description.
 *
 * Matching is done on the *normalised* description — uppercased, with card
 * scheme noise, references and dates stripped — because that is the form in
 * which two months of the same standing order look alike.
 */
export interface RuleMatch {
  /** Every one of these must appear. */
  readonly all?: readonly string[];
  /** At least one of these must appear. */
  readonly any?: readonly string[];
  /** None of these may appear. Checked last, and it wins. */
  readonly none?: readonly string[];
  /** Applied to the normalised description, case-insensitively. */
  readonly regex?: string;
}

/**
 * What to do with a line that matches.
 *
 * `book` is the usual case. `skip` exists because some statement lines are not
 * transactions at all: an opening balance line is the bank telling you where it
 * thinks you started, and booking it would double-count the whole period.
 */
export type RuleAction = "book" | "skip";

export interface PostingRule {
  readonly id: string;
  /** What a person reading the output should understand this rule to mean. */
  readonly describe: string;
  readonly match: RuleMatch;
  /** Restrict to money in or money out. Interest earned and interest paid are
   *  the same word and different accounts. */
  readonly direction?: Direction;
  readonly action?: RuleAction;
  /** The other side of the entry. Required when the action is `book`. */
  readonly account?: string;
  /** Narration for the entry. Defaults to the statement description. */
  readonly narration?: string;
}

export class PostingRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostingRuleError";
  }
}

/**
 * The rules that come in the box, against the standard chart.
 *
 * Ordered, and the order is load-bearing: `INTEREST` outbound is a cost of
 * borrowing and `INTEREST` inbound is income, so the two interest rules must
 * be narrower than the general charges rule that follows them. Opening balance
 * lines are skipped first, before anything can classify them as a receipt.
 *
 * This is a starting point and not a claim about anybody's business. A chart
 * that is not this chart needs its own rules; that is what `--rules` is for.
 */
export function standardRules(): readonly PostingRule[] {
  return Object.freeze([
    {
      id: "opening-balance",
      describe: "an opening balance line, which is not a transaction",
      match: { any: ["BALANCE BROUGHT FORWARD", "BROUGHT FORWARD", "OPENING BALANCE", "BALANCE B F"] },
      action: "skip" as const,
    },
    {
      id: "interest-received",
      describe: "interest credited by the bank",
      match: { any: ["INTEREST", "GROSS INT"] },
      direction: "in" as const,
      account: "4300",
      narration: "Interest received",
    },
    {
      id: "interest-paid",
      describe: "interest charged on borrowing",
      match: { all: ["INTEREST"] },
      direction: "out" as const,
      account: "5800",
      narration: "Interest paid",
    },
    {
      id: "bank-charges",
      describe: "a fee charged by the bank itself",
      match: {
        any: [
          "ACCOUNT MAINTENANCE FEE",
          "BANK CHARGE",
          "SERVICE CHARGE",
          "OVERDRAFT FEE",
          "UNPAID ITEM FEE",
          "NON STERLING",
          "TRANSACTION CHARGE",
        ],
      },
      direction: "out" as const,
      account: "5800",
      narration: "Bank charges",
    },
    {
      id: "processing-fees",
      describe: "a card or payment processor's cut",
      match: { any: ["MERCHANT FEE", "PROCESSING FEE", "CARD FEE", "STRIPE FEE", "SUMUP FEE"] },
      direction: "out" as const,
      account: "5500",
      narration: "Payment processing fees",
    },
    {
      id: "payroll",
      describe: "net pay leaving the account",
      match: { any: ["PAYROLL", "NET PAY", "SALARIES", "WAGES"], none: ["HMRC", "PAYE"] },
      direction: "out" as const,
      account: "5200",
      narration: "Payroll — net pay",
    },
    {
      id: "payroll-taxes",
      describe: "PAYE and national insurance settled with the revenue",
      match: { any: ["HMRC PAYE", "PAYE NIC", "PAYE", "NATIONAL INSURANCE"] },
      direction: "out" as const,
      account: "2300",
      narration: "PAYE and NIC",
    },
    {
      id: "vat",
      describe: "a VAT payment or repayment",
      match: { any: ["HMRC VAT", "VAT RETURN", "VAT PAYMENT"] },
      account: "2200",
      narration: "VAT",
    },
    {
      id: "rent",
      describe: "rent on the premises",
      match: { any: ["RENT", "PROPERTY RENT", "LANDLORD"] },
      direction: "out" as const,
      account: "5300",
      narration: "Rent",
    },
    {
      id: "software",
      describe: "a software subscription",
      match: {
        any: ["SOFTWARE", "SUBSCRIPTION", "AWS", "GOOGLE CLOUD", "MICROSOFT", "ADOBE", "SLACK", "GITHUB"],
      },
      direction: "out" as const,
      account: "5400",
      narration: "Software",
    },
    {
      id: "travel",
      describe: "travel and fares",
      match: { any: ["TRAINLINE", "RAIL", "UBER", "AIRLINE", "TAXI", "TFL", "PARKING"] },
      direction: "out" as const,
      account: "5600",
      narration: "Travel",
    },
    {
      id: "professional-fees",
      describe: "accountants, solicitors and the like",
      match: { any: ["SOLICITOR", "ACCOUNTANT", "LEGAL", "AUDIT FEE", "CONSULTANCY FEE"] },
      direction: "out" as const,
      account: "5700",
      narration: "Professional fees",
    },
    {
      id: "drawings",
      describe: "money taken out by the owner",
      match: { any: ["DRAWINGS", "OWNER DRAW", "DIVIDEND"] },
      direction: "out" as const,
      account: "3300",
      narration: "Drawings",
    },
  ]);
}

/** Why a proposal came out the way it did. */
export type ProposalOutcome = "book" | "skip" | "unclassified" | "already-booked";

export interface Proposal {
  readonly line: StatementLine;
  readonly outcome: ProposalOutcome;
  /** The rule that fired, when one did. */
  readonly rule: PostingRule | null;
  /** The entry to post. Present only when the outcome is `book`. */
  readonly entry: JournalEntry | null;
  /** The account the other side lands in, when there is one. */
  readonly account: string | null;
  /** One line a person can read. */
  readonly reason: string;
}

export interface ProposalOptions {
  /** The account the statement belongs to. */
  readonly account: string;
  readonly rules?: readonly PostingRule[];
  /**
   * Where lines no rule matched should go. Must already exist in the chart;
   * nothing here creates an account. Omitted means they stay unclassified.
   */
  readonly suspenseAccount?: string;
  /** Prefix for generated entry ids. */
  readonly idPrefix?: string;
  /**
   * `1` when a debit to the account is money in — an asset, the normal case —
   * and `-1` for a liability such as a credit card. Matches `bankView`.
   */
  readonly inflowSign?: 1 | -1;
  /** Skip lines whose implied entry the ledger already holds. */
  readonly ledger?: Ledger;
  readonly chart?: ChartOfAccounts;
  /** Tags to put on every entry, so an import can be found again. */
  readonly tags?: readonly string[];
}

const DEFAULT_PREFIX = "BNK";

function matches(rule: PostingRule, line: StatementLine): boolean {
  const text = line.normalisedDescription;
  const test = rule.match;

  if (test.none !== undefined && test.none.some((token) => text.includes(token.toUpperCase()))) {
    return false;
  }
  if (test.all !== undefined && !test.all.every((token) => text.includes(token.toUpperCase()))) {
    return false;
  }
  if (test.any !== undefined && !test.any.some((token) => text.includes(token.toUpperCase()))) {
    return false;
  }
  if (test.regex !== undefined) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(test.regex, "i");
    } catch (error) {
      throw new PostingRuleError(
        `Rule ${rule.id} has an unusable regex: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!pattern.test(text)) return false;
  }
  if (test.all === undefined && test.any === undefined && test.regex === undefined) {
    // A rule with only a `none` clause would match everything that is not
    // excluded, which is never what anybody means.
    throw new PostingRuleError(`Rule ${rule.id} matches on nothing`);
  }
  return true;
}

/**
 * Which way the money went.
 *
 * Taken from the statement's own convention — positive is money into the
 * account — and not from `inflowSign`. `inflowSign` decides which side of the
 * *ledger* the movement lands on; it does not change the fact that a purchase
 * on a credit card is money going out. Conflating the two is how a card fee
 * ends up classified as income.
 */
function directionOf(line: StatementLine): Direction {
  return line.amount.isNegative ? "out" : "in";
}

function directionAllows(rule: PostingRule, direction: Direction): boolean {
  const wanted = rule.direction ?? "either";
  return wanted === "either" || wanted === direction;
}

/** The entry id a statement line implies, whoever asks and however often. */
export function impliedEntryId(line: StatementLine, prefix = DEFAULT_PREFIX): string {
  return `${prefix}-${line.fingerprint}`;
}

/**
 * Turn a statement line into the entry it implies.
 *
 * The bank account takes the movement as the statement reported it; the
 * contra account takes the other side. For an asset account money in is a
 * debit, which is the identity — but a credit-card control account works the
 * other way round, so the sign is applied explicitly rather than assumed.
 */
function entryFor(
  line: StatementLine,
  options: {
    bankAccount: string;
    contraAccount: string;
    narration: string;
    id: string;
    inflowSign: 1 | -1;
    chart?: ChartOfAccounts | undefined;
    tags: readonly string[];
  },
): JournalEntry {
  const bankSide = options.inflowSign === 1 ? line.amount : line.amount.negated();
  const input = {
    id: options.id,
    date: line.date,
    narration: options.narration,
    postings: [
      { account: options.bankAccount, amount: bankSide, memo: line.description },
      { account: options.contraAccount, amount: bankSide.negated(), memo: line.description },
    ],
    tags: options.tags,
    ...(line.reference !== null ? { reference: line.reference } : {}),
  };
  return JournalEntry.create(input, options.chart);
}

/**
 * What the ledger is missing, one proposal per statement line handed in.
 *
 * Callers pass the lines that reconciliation could not explain. Every line
 * gets a proposal, including the ones that come to nothing: a queue of
 * eleven lines that produced four entries should say so, and say why the
 * other seven did not.
 */
export function proposeEntries(
  lines: readonly StatementLine[],
  options: ProposalOptions,
): readonly Proposal[] {
  const rules = options.rules ?? standardRules();
  const inflowSign = options.inflowSign ?? 1;
  const prefix = options.idPrefix ?? DEFAULT_PREFIX;
  const tags = options.tags ?? ["bank-import"];

  for (const rule of rules) {
    if ((rule.action ?? "book") === "book" && rule.account === undefined) {
      throw new PostingRuleError(`Rule ${rule.id} books something but names no account`);
    }
  }

  const proposals: Proposal[] = [];

  for (const line of lines) {
    const direction = directionOf(line);
    const rule = rules.find((candidate) => directionAllows(candidate, direction) && matches(candidate, line));

    if (rule !== undefined && (rule.action ?? "book") === "skip") {
      proposals.push(
        Object.freeze({
          line,
          outcome: "skip" as const,
          rule,
          entry: null,
          account: null,
          reason: `not booked: ${rule.describe}`,
        }),
      );
      continue;
    }

    const account = rule?.account ?? options.suspenseAccount;
    if (account === undefined) {
      proposals.push(
        Object.freeze({
          line,
          outcome: "unclassified" as const,
          rule: null,
          entry: null,
          account: null,
          reason: "no rule matched, and no suspense account was named",
        }),
      );
      continue;
    }

    const id = impliedEntryId(line, prefix);
    if (options.ledger?.has(id) === true) {
      proposals.push(
        Object.freeze({
          line,
          outcome: "already-booked" as const,
          rule: rule ?? null,
          entry: null,
          account,
          reason: `already in the ledger as ${id}`,
        }),
      );
      continue;
    }

    const entry = entryFor(line, {
      bankAccount: options.account,
      contraAccount: account,
      narration: rule?.narration ?? line.description,
      id,
      inflowSign,
      chart: options.chart ?? options.ledger?.chart,
      tags,
    });

    proposals.push(
      Object.freeze({
        line,
        outcome: "book" as const,
        rule: rule ?? null,
        entry,
        account,
        reason:
          rule === undefined
            ? `no rule matched; posted to the suspense account ${account}`
            : `${rule.describe} → ${account}`,
      }),
    );
  }

  return Object.freeze(proposals);
}

/** Post everything a proposal set says to post, in the order it was proposed. */
export function applyProposals(ledger: Ledger, proposals: readonly Proposal[]): Ledger {
  const entries = proposals
    .filter((proposal) => proposal.outcome === "book" && proposal.entry !== null)
    .map((proposal) => proposal.entry as JournalEntry);
  return ledger.postMany(entries);
}

export interface ProposalSummary {
  readonly total: number;
  readonly booked: number;
  readonly skipped: number;
  readonly unclassified: number;
  readonly alreadyBooked: number;
  /** Net effect on the bank account, in the statement's own direction. */
  readonly net: Money;
  /** Booked totals per contra account, most material first. */
  readonly byAccount: readonly { readonly account: string; readonly amount: Money; readonly count: number }[];
}

export function summariseProposals(
  proposals: readonly Proposal[],
  currency: Money["currency"] | string,
): ProposalSummary {
  const zero = Money.zero(currency);
  const byAccount = new Map<string, { amount: Money; count: number }>();
  let net = zero;

  for (const proposal of proposals) {
    if (proposal.outcome !== "book" || proposal.account === null) continue;
    net = net.plus(proposal.line.amount);
    const existing = byAccount.get(proposal.account) ?? { amount: zero, count: 0 };
    byAccount.set(proposal.account, {
      amount: existing.amount.plus(proposal.line.amount),
      count: existing.count + 1,
    });
  }

  const count = (outcome: ProposalOutcome): number =>
    proposals.filter((proposal) => proposal.outcome === outcome).length;

  return Object.freeze({
    total: proposals.length,
    booked: count("book"),
    skipped: count("skip"),
    unclassified: count("unclassified"),
    alreadyBooked: count("already-booked"),
    net,
    byAccount: Object.freeze(
      [...byAccount.entries()]
        .map(([account, totals]) => ({ account, amount: totals.amount, count: totals.count }))
        .sort(
          (a, b) =>
            Number(b.amount.abs().minorUnits - a.amount.abs().minorUnits) ||
            (a.account < b.account ? -1 : 1),
        ),
    ),
  });
}

/** Read a rules file. */
export function parseRules(text: string): readonly PostingRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new PostingRuleError(
      `The rules file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) throw new PostingRuleError("The rules file must be a JSON array");

  return Object.freeze(
    parsed.map((value, index) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new PostingRuleError(`Rule ${index} must be an object`);
      }
      const raw = value as Record<string, unknown>;
      if (typeof raw["id"] !== "string" || raw["id"].trim() === "") {
        throw new PostingRuleError(`Rule ${index} needs an id`);
      }
      const id = raw["id"];
      const action = raw["action"] ?? "book";
      if (action !== "book" && action !== "skip") {
        throw new PostingRuleError(`Rule ${id} has an action that is neither book nor skip`);
      }
      if (action === "book" && typeof raw["account"] !== "string") {
        throw new PostingRuleError(`Rule ${id} books something but names no account`);
      }
      const direction = raw["direction"] ?? "either";
      if (direction !== "in" && direction !== "out" && direction !== "either") {
        throw new PostingRuleError(`Rule ${id} has a direction that is not in, out or either`);
      }
      const match = raw["match"];
      if (typeof match !== "object" || match === null || Array.isArray(match)) {
        throw new PostingRuleError(`Rule ${id} needs a match object`);
      }
      const clauses = match as Record<string, unknown>;
      for (const key of ["all", "any", "none"] as const) {
        const clause = clauses[key];
        if (clause === undefined) continue;
        if (!Array.isArray(clause) || clause.some((token) => typeof token !== "string")) {
          throw new PostingRuleError(`Rule ${id} has a match.${key} that is not a list of strings`);
        }
      }
      if (clauses["regex"] !== undefined && typeof clauses["regex"] !== "string") {
        throw new PostingRuleError(`Rule ${id} has a match.regex that is not a string`);
      }

      return Object.freeze({
        id,
        describe: typeof raw["describe"] === "string" ? raw["describe"] : id,
        match: Object.freeze({ ...(match as RuleMatch) }),
        direction: direction as Direction,
        action: action as RuleAction,
        ...(typeof raw["account"] === "string" ? { account: raw["account"] } : {}),
        ...(typeof raw["narration"] === "string" ? { narration: raw["narration"] } : {}),
      });
    }),
  );
}

/** The proposals, as something a person can read down. */
export function renderProposals(
  proposals: readonly Proposal[],
  summary: ProposalSummary,
): string {
  if (proposals.length === 0) return "Nothing on the statement is missing from the books.";

  const rows = proposals.map((proposal) => [
    proposal.line.date,
    proposal.line.description.length > 34
      ? `${proposal.line.description.slice(0, 33)}…`
      : proposal.line.description,
    proposal.line.amount.toDecimalString(),
    proposal.account ?? "—",
    proposal.outcome === "book" ? (proposal.rule?.id ?? "suspense") : proposal.outcome,
  ]);
  const header = ["date", "description", "amount", "account", "rule"];
  const numeric = [false, false, true, false, false];
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => (row[column] as string).length)),
  );
  const format = (cells: readonly string[]): string =>
    cells
      .map((cell, column) =>
        numeric[column] === true
          ? cell.padStart(widths[column] as number)
          : cell.padEnd(widths[column] as number),
      )
      .join("  ")
      .trimEnd();

  const lines = [format(header), ...rows.map(format), ""];

  lines.push(
    `${summary.booked} to book, ${summary.skipped} skipped, ` +
      `${summary.alreadyBooked} already in the ledger, ${summary.unclassified} unclassified`,
  );
  if (summary.booked > 0) {
    lines.push(`Net effect on the bank account: ${summary.net.toDecimalString()}`);
    lines.push("");
    for (const total of summary.byAccount) {
      lines.push(
        `  ${total.account}  ${total.amount.toDecimalString().padStart(12)}  ` +
          `(${total.count} ${total.count === 1 ? "line" : "lines"})`,
      );
    }
  }

  return lines.join("\n");
}


/**
 * Which statement lines still need booking.
 *
 * The unmatched ones, plainly — nothing in the books corresponds to them. And
 * then the ones sitting under a suggestion the reviewer has already refused:
 * a rejected pairing is a person saying this line does *not* belong to that
 * entry, which leaves the line with no counterpart at all.
 *
 * A suggestion nobody has decided is left alone. The matcher believes there is
 * a ledger entry behind it, and booking a second one would double-count the
 * transaction. Undecided means unproposed, which is the conservative reading
 * and the right one: a missed entry is a reconciliation that does not balance,
 * and a duplicated entry is a reconciliation that balances and is wrong.
 *
 * "Refused" means every description pair in the suggestion recalls as rejected.
 * A batch where the reviewer refused one of four suppliers is still, in part,
 * something the books know about.
 */
export function linesNeedingEntries(
  result: ReconciliationResult,
  memory?: MatchMemory,
): readonly StatementLine[] {
  const lines = [...result.unmatchedStatement];

  if (memory !== undefined && memory.size > 0) {
    for (const suggestion of result.suggested) {
      const pairs = suggestion.statement.flatMap((statement) =>
        suggestion.book.map((book) => memory.recall(statement.description, book.description)),
      );
      if (pairs.length > 0 && pairs.every((verdict) => verdict.kind === "rejected")) {
        lines.push(...suggestion.statement);
      }
    }
  }

  return Object.freeze(
    lines.sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? -1 : 1)),
  );
}
