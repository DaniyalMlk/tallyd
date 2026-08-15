/**
 * What the page needs to know.
 *
 * The dashboard is a single HTML file with its data baked in, so this module
 * flattens a ledger, a statement and a reconciliation into something that
 * survives `JSON.stringify` — plain strings and numbers, no `Money`, no
 * `bigint`, no class instances.
 *
 * Amounts cross that boundary twice: once as a decimal string for display, and
 * once as a count of minor units for arithmetic in the browser. Keeping both is
 * deliberate. The browser has to re-add the bridge every time a match is
 * accepted, and doing that on formatted strings — or on floats parsed from them
 * — is how a reconciliation ends up out by a penny in the one place a penny
 * matters.
 */

import { Money } from "../money/money.js";
import type { AccountType } from "../accounts/types.js";
import { debitSign } from "../accounts/types.js";
import type { CalendarDate } from "../ledger/date.js";
import type { Ledger } from "../ledger/ledger.js";
import type { StatementLine } from "../statement/line.js";
import type { BookLine } from "../reconcile/bankView.js";
import type { Match, ReconciliationResult } from "../reconcile/matcher.js";
import { significantReasons } from "../reconcile/matcher.js";
import { trialBalance } from "../ledger/trialBalance.js";

export interface AmountView {
  /** For display: `-1850.00`. */
  readonly text: string;
  /** For arithmetic: signed minor units, as a JSON-safe number. */
  readonly minor: number;
}

export interface LineView {
  readonly id: string;
  readonly date: string;
  readonly description: string;
  readonly amount: AmountView;
  /** `book` or `bank`, so the page can label a line without being told twice. */
  readonly side: "book" | "bank";
  readonly reference: string | null;
}

export interface MatchView {
  readonly id: string;
  readonly kind: Match["kind"];
  readonly confidence: string;
  readonly score: number;
  readonly book: readonly LineView[];
  readonly statement: readonly LineView[];
  readonly reasons: readonly string[];
  readonly amount: AmountView;
}

export interface AccountView {
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly depth: number;
  readonly balance: AmountView;
  readonly postings: number;
}

export interface PostingView {
  readonly entryId: string;
  readonly date: string;
  readonly narration: string;
  readonly account: string;
  readonly amount: AmountView;
  readonly contra: readonly string[];
}

export interface SeriesPoint {
  readonly date: string;
  readonly minor: number;
}

export interface DashboardData {
  readonly generatedFor: string;
  readonly account: string;
  readonly accountName: string;
  readonly currency: string;
  readonly currencySymbol: string;
  readonly exponent: number;
  readonly period: { readonly from: string; readonly to: string };

  readonly matched: readonly MatchView[];
  readonly suggested: readonly MatchView[];
  readonly unmatchedBook: readonly LineView[];
  readonly unmatchedStatement: readonly LineView[];

  /** Closing balances the bridge starts from, in minor units. */
  readonly bankClosingMinor: number;
  readonly bookClosingMinor: number;

  readonly accounts: readonly AccountView[];
  readonly postings: readonly PostingView[];

  readonly cashPosition: readonly SeriesPoint[];
  readonly confidence: readonly { readonly label: string; readonly count: number }[];

  readonly trialBalanceBalanced: boolean;
  readonly statementFormat: string;
}

function amountOf(money: Money): AmountView {
  return { text: money.toDecimalString(), minor: Number(money.minorUnits) };
}

function bookLineView(line: BookLine): LineView {
  return {
    id: line.id,
    date: line.date,
    description: line.description,
    amount: amountOf(line.amount),
    side: "book",
    reference: line.reference,
  };
}

function statementLineView(line: StatementLine): LineView {
  return {
    id: line.id,
    date: line.date,
    description: line.description,
    amount: amountOf(line.amount),
    side: "bank",
    reference: line.reference,
  };
}

function matchView(match: Match, index: number, bucket: string): MatchView {
  const minor = match.statement.reduce((sum, line) => sum + Number(line.amount.minorUnits), 0);
  const currency = match.statement[0]?.amount.currency ?? match.book[0]?.amount.currency;
  const exponent = currency?.exponent ?? 2;
  return {
    id: `${bucket}-${index}`,
    kind: match.kind,
    confidence: match.scored.confidence,
    score: Number(match.scored.score.toFixed(4)),
    book: match.book.map(bookLineView),
    statement: match.statement.map(statementLineView),
    reasons: significantReasons(match),
    amount: { text: formatMinor(minor, exponent), minor },
  };
}

function formatMinor(minor: number, exponent: number): string {
  const negative = minor < 0;
  const digits = Math.abs(minor).toString().padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? "" : `.${digits.slice(digits.length - exponent)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/** Running balance of the bank account, one point per day it moved. */
function cashPosition(lines: readonly BookLine[]): readonly SeriesPoint[] {
  const byDate = new Map<string, number>();
  for (const line of lines) {
    byDate.set(line.date, (byDate.get(line.date) ?? 0) + Number(line.amount.minorUnits));
  }
  const dates = [...byDate.keys()].sort();
  const points: SeriesPoint[] = [];
  let running = 0;
  for (const date of dates) {
    running += byDate.get(date) ?? 0;
    points.push({ date, minor: running });
  }
  return points;
}

const CONFIDENCE_ORDER = ["exact", "high", "medium", "low"] as const;

/** A grouping account's balance is the sum of its subtree, on its normal side. */
function rolledUpNatural(
  ledger: Ledger,
  chart: NonNullable<Ledger["chart"]>,
  code: string,
  type: AccountType,
): Money {
  const total = chart
    .subtree(code)
    .reduce((sum, node) => sum + ledger.balanceOf(node.code).minorUnits, 0n);
  const signed = debitSign(type) === 1 ? total : -total;
  return Money.ofMinor(signed, ledger.balanceOf(code).currency);
}

export interface DashboardInput {
  readonly ledger: Ledger;
  readonly account: string;
  readonly books: readonly BookLine[];
  readonly statement: readonly StatementLine[];
  readonly result: ReconciliationResult;
  readonly bankClosingBalance: Money;
  readonly bookClosingBalance: Money;
  readonly statementFormat: string;
  readonly generatedFor?: string;
}

export function dashboardData(input: DashboardInput): DashboardData {
  const currency = input.bankClosingBalance.currency;

  const dates = [
    ...input.books.map((line) => line.date),
    ...input.statement.map((line) => line.date),
  ].sort();
  const from = (dates[0] ?? "") as CalendarDate | "";
  const to = (dates[dates.length - 1] ?? "") as CalendarDate | "";

  const counts = new Map<string, number>();
  for (const match of [...input.result.matched, ...input.result.suggested]) {
    counts.set(match.scored.confidence, (counts.get(match.scored.confidence) ?? 0) + 1);
  }

  // An account nothing has ever touched is noise in a report about what
  // happened. A grouping account earns its row only when something below it
  // did, and then it shows the rolled-up total rather than its own zero.
  const chart = input.ledger.chart;
  const accounts: AccountView[] = [];
  for (const account of chart?.list() ?? []) {
    const detail = input.ledger.accountBalance(account.code);
    const isLeaf = account.children.length === 0;
    const subtreePostings = isLeaf
      ? detail.postingCount
      : (chart as NonNullable<typeof chart>)
          .subtree(account.code)
          .reduce((sum, node) => sum + input.ledger.accountBalance(node.code).postingCount, 0);
    if (subtreePostings === 0) continue;

    const balance = isLeaf
      ? detail.natural
      : rolledUpNatural(input.ledger, chart as NonNullable<typeof chart>, account.code, account.type);

    accounts.push({
      code: account.code,
      name: account.name,
      type: account.type,
      depth: account.depth,
      balance: amountOf(balance),
      postings: subtreePostings,
    });
  }

  const postings: PostingView[] = [];
  for (const entry of input.ledger.chronological()) {
    for (const posting of entry.postings) {
      postings.push({
        entryId: entry.id,
        date: entry.date,
        narration: entry.narration,
        account: posting.account,
        amount: amountOf(posting.amount),
        contra: [
          ...new Set(
            entry.postings.filter((p) => p.account !== posting.account).map((p) => p.account),
          ),
        ].sort(),
      });
    }
  }

  return {
    generatedFor: input.generatedFor ?? "tallyd",
    account: input.account,
    accountName: input.ledger.chart?.find(input.account)?.name ?? input.account,
    currency: currency.code,
    currencySymbol: currency.symbol,
    exponent: currency.exponent,
    period: { from: from === "" ? "—" : from, to: to === "" ? "—" : to },

    matched: input.result.matched.map((match, index) => matchView(match, index, "m")),
    suggested: input.result.suggested.map((match, index) => matchView(match, index, "s")),
    unmatchedBook: input.result.unmatchedBook.map(bookLineView),
    unmatchedStatement: input.result.unmatchedStatement.map(statementLineView),

    bankClosingMinor: Number(input.bankClosingBalance.minorUnits),
    bookClosingMinor: Number(input.bookClosingBalance.minorUnits),

    accounts,
    postings,

    cashPosition: cashPosition(input.books),
    confidence: CONFIDENCE_ORDER.map((label) => ({ label, count: counts.get(label) ?? 0 })),

    trialBalanceBalanced: trialBalance(input.ledger).balanced,
    statementFormat: input.statementFormat,
  };
}
