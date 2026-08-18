/**
 * The period-end revaluation.
 *
 * A euro receivable raised in January at 0.8400 is still worth 1,000 EUR in
 * March, but 1,000 EUR is no longer worth 840.00 GBP. The books carry it at
 * what it was booked at; the balance sheet is supposed to show what it is worth
 * at the closing rate. The difference is an unrealised gain or loss, and the
 * revaluation is the entry that books it.
 *
 * Two properties this implementation is built around.
 *
 * **It is idempotent.** The adjustment is computed against the carrying amount,
 * which includes every revaluation already posted — so running it twice on the
 * same date produces the second entry as nothing at all, rather than doubling
 * the adjustment. That also means the usual reverse-it-next-month dance is
 * optional rather than required: leaving last month's revaluation in place and
 * running this month's gives the same balance sheet either way.
 *
 * **It is one entry.** Every exposure adjusts in the same entry, with a single
 * pair of gain and loss postings netting the whole thing. Splitting the gain
 * and loss out per account would be more granular and less useful: the
 * question a reviewer asks is "what did the rate move cost us this month", and
 * that is one number.
 */

import type { Currency } from "../money/currency.js";
import { currency as lookupCurrency } from "../money/currency.js";
import { Money, sumMoney } from "../money/money.js";
import type { RoundingMode } from "../money/rounding.js";
import { type CalendarDate, date as parseDate } from "../ledger/date.js";
import { JournalEntry, type PostingInput } from "../ledger/entry.js";
import type { Ledger } from "../ledger/ledger.js";
import type { ExchangeRate } from "./rate.js";
import { type ExposureOptions, exposures } from "./exposure.js";
import type { RateLookup, RateTable } from "./table.js";

export class RevaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevaluationError";
  }
}

/** What one exposure's retranslation came to. */
export interface RevaluationLine {
  readonly account: string;
  readonly name: string;
  readonly currency: Currency;
  readonly foreignBalance: Money;
  /** What the books carried it at before this entry. */
  readonly carryingAmount: Money;
  /** What the closing rate says it is worth. */
  readonly closingAmount: Money;
  /** closingAmount - carryingAmount. Positive is a debit to the account. */
  readonly adjustment: Money;
  readonly closingRate: ExchangeRate;
  readonly lookup: RateLookup;
}

export interface Revaluation {
  readonly asAt: CalendarDate;
  readonly functional: Currency;
  readonly lines: readonly RevaluationLine[];
  /** The net effect on the P&L. Positive is a gain. */
  readonly net: Money;
  readonly gain: Money;
  readonly loss: Money;
  /** Null when nothing moved — which is the common case, and not an error. */
  readonly entry: JournalEntry | null;
}

export interface RevaluationOptions extends Omit<ExposureOptions, "asAt"> {
  asAt: string;
  rates: RateTable;
  /** Entry id. Defaults to `FX-REVAL-<date>`, which is idempotent by name too. */
  id?: string;
  narration?: string;
  /** Income account for a net gain. Defaults to 4400 in the standard chart. */
  gainAccount?: string;
  /** Expense account for a net loss. Defaults to 5950. */
  lossAccount?: string;
  rounding?: RoundingMode;
  tags?: readonly string[];
}

const DEFAULT_GAIN = "4400";
const DEFAULT_LOSS = "5950";

function functionalOf(ledger: Ledger, requested: Currency | string | undefined): Currency {
  if (requested !== undefined) {
    return typeof requested === "string" ? lookupCurrency(requested) : requested;
  }
  const chart = ledger.chart;
  if (chart !== undefined) return chart.defaultCurrency;
  const used = ledger.currenciesUsed()[0];
  if (used === undefined) throw new RevaluationError("Cannot tell what currency the books are in");
  return lookupCurrency(used);
}

/**
 * Retranslate every foreign-currency balance at the closing rate.
 *
 * Nothing is posted: the result carries the entry, and the caller decides
 * whether to put it in the ledger. A revaluation is a judgement about a date,
 * and computing one is not the same as agreeing with it.
 */
export function revalue(ledger: Ledger, options: RevaluationOptions): Revaluation {
  const asAt = parseDate(options.asAt);
  const functional = functionalOf(ledger, options.functional);
  const rounding = options.rounding ?? "half-even";

  const exposureOptions: ExposureOptions = {
    functional,
    asAt,
    ...(options.accounts === undefined ? {} : { accounts: options.accounts }),
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
  };

  const lines: RevaluationLine[] = [];
  for (const exposure of exposures(ledger, exposureOptions)) {
    const lookup = options.rates.lookup(exposure.currency, functional, asAt);
    const closingAmount = lookup.rate.convert(exposure.foreignBalance, rounding);
    const adjustment = closingAmount.minus(exposure.carryingAmount);
    lines.push(
      Object.freeze({
        account: exposure.account,
        name: exposure.name,
        currency: exposure.currency,
        foreignBalance: exposure.foreignBalance,
        carryingAmount: exposure.carryingAmount,
        closingAmount,
        adjustment,
        closingRate: lookup.rate,
        lookup,
      }),
    );
  }

  const moved = lines.filter((line) => !line.adjustment.isZero);
  const net = sumMoney(
    moved.map((line) => line.adjustment),
    functional,
  );
  const gain = sumMoney(
    moved.filter((l) => l.adjustment.isPositive).map((l) => l.adjustment),
    functional,
  );
  const loss = sumMoney(
    moved.filter((l) => l.adjustment.isNegative).map((l) => l.adjustment.negated()),
    functional,
  );

  // A net of zero across two accounts that both moved is still worth posting —
  // it moves each balance sheet line, and the P&L shows the gross gain and the
  // gross loss. Only a revaluation where nothing moved at all is a no-op.
  if (moved.length === 0) {
    return Object.freeze({
      asAt,
      functional,
      lines: Object.freeze(lines),
      net,
      gain,
      loss,
      entry: null,
    });
  }

  const gainAccount = options.gainAccount ?? DEFAULT_GAIN;
  const lossAccount = options.lossAccount ?? DEFAULT_LOSS;
  const chart = ledger.chart;
  for (const [code, what] of [
    [gainAccount, "gain"],
    [lossAccount, "loss"],
  ] as const) {
    if (chart !== undefined && !chart.isPostable(code)) {
      throw new RevaluationError(
        `The ${what} account ${code} is not one this chart can post to`,
      );
    }
  }

  const postings: PostingInput[] = moved.map((line) => ({
    account: line.account,
    amount: line.adjustment,
    memo: `${line.foreignBalance.toString()} at ${line.closingRate.toDecimalString(6)}`,
  }));

  // The P&L side. A net gain is a credit to income; a net loss is a debit to
  // expense. Both are posted when the two sides net to zero but each is
  // non-zero, so the P&L shows the gross movement rather than silence.
  if (net.isPositive) {
    postings.push({ account: gainAccount, amount: net.negated(), memo: "Retranslation at close" });
  } else if (net.isNegative) {
    postings.push({ account: lossAccount, amount: net.negated(), memo: "Retranslation at close" });
  } else {
    postings.push({ account: gainAccount, amount: gain.negated(), memo: "Retranslation at close" });
    postings.push({ account: lossAccount, amount: loss, memo: "Retranslation at close" });
  }

  const entry = JournalEntry.create(
    {
      id: options.id ?? `FX-REVAL-${asAt}`,
      date: asAt,
      narration: options.narration ?? `Revaluation of foreign-currency balances at ${asAt}`,
      postings,
      tags: options.tags ?? ["fx", "unrealised"],
    },
    chart,
  );

  return Object.freeze({
    asAt,
    functional,
    lines: Object.freeze(lines),
    net,
    gain,
    loss,
    entry,
  });
}

/** Compute and post in one step. Returns the ledger unchanged when nothing moved. */
export function applyRevaluation(ledger: Ledger, options: RevaluationOptions): Ledger {
  const result = revalue(ledger, options);
  return result.entry === null ? ledger : ledger.post(result.entry);
}

export function renderRevaluation(result: Revaluation): string {
  if (result.lines.length === 0) {
    return `No foreign-currency balances to revalue at ${result.asAt}.`;
  }
  const width = Math.max(12, ...result.lines.map((l) => l.name.length));
  const lines = [
    `Revaluation at ${result.asAt} (books kept in ${result.functional.code})`,
    "-".repeat(width + 62),
    "Account".padEnd(8) +
      "Name".padEnd(width + 2) +
      "Balance".padStart(16) +
      "Carried".padStart(12) +
      "Closing".padStart(12) +
      "Move".padStart(11),
  ];
  for (const line of result.lines) {
    lines.push(
      line.account.padEnd(8) +
        line.name.padEnd(width + 2) +
        `${line.foreignBalance.toDecimalString()} ${line.currency.code}`.padStart(16) +
        line.carryingAmount.toDecimalString().padStart(12) +
        line.closingAmount.toDecimalString().padStart(12) +
        line.adjustment.toDecimalString().padStart(11),
    );
  }
  lines.push("-".repeat(width + 62));
  if (result.entry === null) {
    lines.push("Nothing to post: every balance is already carried at the closing rate.");
  } else {
    const direction = result.net.isPositive ? "gain" : "loss";
    lines.push(
      `Net unrealised ${direction} of ${result.net.abs().toDecimalString()} ` +
        `${result.functional.code}, in entry ${result.entry.id}`,
    );
    const rates = result.lines
      .filter((l) => !l.adjustment.isZero)
      .map((l) => `${l.currency.code}/${result.functional.code} ${l.closingRate.toDecimalString(6)}`);
    if (rates.length > 0) lines.push(`Rates used: ${[...new Set(rates)].join(", ")}`);
  }
  return lines.join("\n");
}
