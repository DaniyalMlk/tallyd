/**
 * Presenting the statements in a currency the books are not kept in.
 *
 * This is a different problem from a euro receivable and it does not have the
 * same answer. A receivable is retranslated because what it is worth genuinely
 * changed. Nothing changes here: the business did what it did, and someone
 * wants to read the result in dollars. So no balance is restated — the whole
 * statement is, and each line takes the rate its nature calls for.
 *
 * - **Assets and liabilities** at the closing rate. What is owned and owed
 *   exists on the balance sheet date, so it is worth what it is worth that day.
 * - **Income and expenses** at the average rate for the period. Revenue earned
 *   across March was not all earned on 31 March, and translating it at the
 *   close would price a year of trading at one day's rate.
 * - **Equity** at the rate on the day each movement happened. Share capital
 *   subscribed in 2019 was subscribed at the 2019 rate; nothing since has
 *   changed what was put in.
 *
 * Using three different rates has an arithmetic consequence: the translated
 * debits and credits no longer agree. That difference is not a bug and must not
 * be hidden. It is the cumulative translation adjustment — the accumulated
 * effect of the rate having moved between the day a thing was recorded and the
 * day the statement is read — and it belongs in equity as a line a reader can
 * point at. A translation that silently plugged it into retained earnings would
 * be claiming the business made money it did not make.
 */

import type { Currency } from "../money/currency.js";
import { currency as lookupCurrency } from "../money/currency.js";
import { Money, sumMoney } from "../money/money.js";
import type { RoundingMode } from "../money/rounding.js";
import type { AccountType } from "../accounts/types.js";
import { type CalendarDate, type DateRange, date as parseDate } from "../ledger/date.js";
import type { Ledger } from "../ledger/ledger.js";
import { type TrialBalance, trialBalance } from "../ledger/trialBalance.js";
import { ExchangeRate, RateError } from "./rate.js";
import { type AverageMethod, averageRate } from "./average.js";
import type { RateTable } from "./table.js";

export class TranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslationError";
  }
}

/** Which rate a line took, and why. */
export type RateBasis =
  /** The rate on the balance sheet date. */
  | "closing"
  /** The mean rate over the reporting period. */
  | "average"
  /** The rate on the day each movement happened. */
  | "historical"
  /** No rate: the books are already in the presentation currency. */
  | "none";

export interface TranslatedRow {
  readonly account: string;
  readonly name: string;
  readonly type: AccountType | null;
  /** The balance as the books hold it. */
  readonly functional: Money;
  /** The same balance, restated. */
  readonly presentation: Money;
  readonly basis: RateBasis;
  /**
   * The rate applied. Null for a historical line, where each movement took its
   * own rate and no single one describes the row; `effectiveRate` is the one
   * the row worked out to.
   */
  readonly rate: ExchangeRate | null;
  /** What the row's two figures imply, whatever basis it used. */
  readonly effectiveRate: ExchangeRate | null;
}

export interface Translation {
  readonly functional: Currency;
  readonly presentation: Currency;
  readonly asAt: CalendarDate;
  readonly period: DateRange;
  readonly rows: readonly TranslatedRow[];
  readonly closingRate: ExchangeRate | null;
  readonly averageRate: ExchangeRate | null;
  readonly averageMethod: AverageMethod;
  /**
   * The balancing figure: what the translated columns are out by before it is
   * included. Positive means the translated credits exceeded the debits.
   */
  readonly translationAdjustment: Money;
  readonly totalDebit: Money;
  readonly totalCredit: Money;
  /** True once the adjustment is counted, which it always is. */
  readonly balanced: boolean;
}

export interface TranslationOptions {
  presentation: Currency | string;
  rates: RateTable;
  /** Balance sheet date. Also the closing rate's date. */
  asAt: string;
  /** The reporting period the average rate covers. Defaults to the year to `asAt`. */
  period?: DateRange;
  functional?: Currency | string;
  averageMethod?: AverageMethod;
  /**
   * Translate equity at the closing rate instead of at the rate on the day
   * each movement happened. Wrong in principle and occasionally the only thing
   * possible, when the rate file does not reach back as far as the share
   * capital does.
   */
  equityBasis?: "historical" | "closing";
  includeZero?: boolean;
  rounding?: RoundingMode;
}

function resolve(value: Currency | string): Currency {
  return typeof value === "string" ? lookupCurrency(value) : value;
}

function basisFor(type: AccountType | null, equityBasis: "historical" | "closing"): RateBasis {
  switch (type) {
    case "asset":
    case "liability":
      return "closing";
    case "income":
    case "expense":
      return "average";
    case "equity":
      return equityBasis === "closing" ? "closing" : "historical";
    default:
      // An account the chart does not know about is a balance sheet item until
      // someone says otherwise; the closing rate is the conservative guess.
      return "closing";
  }
}

/**
 * Translate a trial balance into a presentation currency.
 *
 * Presenting into the currency the books are already kept in returns the
 * statement unchanged, with no rates looked up at all — worth stating because
 * it means a report can pass `--present` unconditionally.
 */
export function translate(ledger: Ledger, options: TranslationOptions): Translation {
  const presentation = resolve(options.presentation);
  const functional =
    options.functional === undefined
      ? (ledger.chart?.defaultCurrency ?? lookupCurrency(ledger.currenciesUsed()[0] ?? "GBP"))
      : resolve(options.functional);
  const asAt = parseDate(options.asAt);
  const rounding = options.rounding ?? "half-even";
  const equityBasis = options.equityBasis ?? "historical";
  const averageMethod = options.averageMethod ?? "daily";

  const period: DateRange =
    options.period ?? Object.freeze({ from: parseDate("0001-01-01"), to: asAt });

  const source: TrialBalance = trialBalance(ledger, {
    currency: functional,
    asAt,
    ...(options.includeZero === true ? { includeZero: true } : {}),
  });

  // ------------------------------------------------------ the identity case
  if (presentation.code === functional.code) {
    const rows = source.rows.map((row) =>
      Object.freeze({
        account: row.account,
        name: row.name,
        type: row.type,
        functional: row.signed,
        presentation: row.signed,
        basis: "none" as RateBasis,
        rate: null,
        effectiveRate: null,
      }),
    );
    return Object.freeze({
      functional,
      presentation,
      asAt,
      period,
      rows: Object.freeze(rows),
      closingRate: null,
      averageRate: null,
      averageMethod,
      translationAdjustment: Money.zero(presentation),
      totalDebit: source.totalDebit,
      totalCredit: source.totalCredit,
      balanced: source.balanced,
    });
  }

  const closing = options.rates.lookup(functional, presentation, asAt).rate;

  const needsAverage = source.rows.some((row) => basisFor(row.type, equityBasis) === "average");
  let average: ExchangeRate | null = null;
  if (needsAverage) {
    // A period that reaches back to year 1 is the "everything so far" default;
    // averaging over two millennia of missing quotes is not what anyone means
    // by it, so the average is taken over the part the table can price.
    average = averageRate(
      options.rates,
      functional,
      presentation,
      period.from,
      period.to,
      averageMethod,
      { skipMissing: true },
    ).rate;
  }

  // --------------------------------------------------- historical for equity
  const historical = new Map<string, Money>();
  if (equityBasis === "historical") {
    for (const entry of ledger.all()) {
      if (entry.date > asAt) continue;
      for (const posting of entry.postings) {
        const type = ledger.chart?.find(posting.account)?.type;
        if (type !== "equity") continue;
        if (posting.amount.currency.code !== functional.code) continue;
        let rate: ExchangeRate;
        try {
          rate = options.rates.lookup(functional, presentation, entry.date).rate;
        } catch (error) {
          throw new TranslationError(
            `Equity is translated at the rate on the day it moved, and entry ${entry.id} ` +
              `(${entry.date}) has no rate: ${(error as Error).message}. Pass ` +
              `equityBasis "closing" to use the closing rate instead.`,
          );
        }
        const running = historical.get(posting.account);
        const translated = rate.convert(posting.amount, rounding);
        historical.set(
          posting.account,
          running === undefined ? translated : running.plus(translated),
        );
      }
    }
  }

  const rows: TranslatedRow[] = source.rows.map((row) => {
    const basis = basisFor(row.type, equityBasis);
    let presented: Money;
    let rate: ExchangeRate | null;
    if (basis === "historical") {
      presented = historical.get(row.account) ?? Money.zero(presentation);
      rate = null;
    } else if (basis === "average") {
      rate = average as ExchangeRate;
      presented = rate.convert(row.signed, rounding);
    } else {
      rate = closing;
      presented = rate.convert(row.signed, rounding);
    }
    let effectiveRate: ExchangeRate | null = rate;
    if (rate === null) {
      try {
        effectiveRate = ExchangeRate.implied(row.signed, presented);
      } catch (error) {
        if (!(error instanceof RateError)) throw error;
        effectiveRate = null;
      }
    }
    return Object.freeze({
      account: row.account,
      name: row.name,
      type: row.type,
      functional: row.signed,
      presentation: presented,
      basis,
      rate,
      effectiveRate,
    });
  });

  // The residual. In the functional currency the signed balances sum to zero;
  // after three different rates they do not, and the difference is the thing
  // being measured rather than a failure to measure.
  const residual = sumMoney(
    rows.map((r) => r.presentation),
    presentation,
  );
  const translationAdjustment = residual.negated();

  const totalDebit = sumMoney(
    rows.filter((r) => r.presentation.isPositive).map((r) => r.presentation),
    presentation,
  ).plus(translationAdjustment.isPositive ? translationAdjustment : Money.zero(presentation));
  const totalCredit = sumMoney(
    rows.filter((r) => r.presentation.isNegative).map((r) => r.presentation.negated()),
    presentation,
  ).plus(translationAdjustment.isNegative ? translationAdjustment.negated() : Money.zero(presentation));

  return Object.freeze({
    functional,
    presentation,
    asAt,
    period,
    rows: Object.freeze(rows),
    closingRate: closing,
    averageRate: average,
    averageMethod,
    translationAdjustment,
    totalDebit,
    totalCredit,
    balanced: totalDebit.equals(totalCredit),
  });
}

export function renderTranslation(result: Translation): string {
  // "Translation adjustment" is a row too, and it is the longest label here.
  const width = Math.max(24, ...result.rows.map((r) => r.name.length));
  const lines: string[] = [];
  lines.push(
    `Trial balance as at ${result.asAt}, presented in ${result.presentation.code} ` +
      `(books kept in ${result.functional.code})`,
  );
  if (result.closingRate !== null) {
    lines.push(
      `Closing ${result.functional.code}/${result.presentation.code} ` +
        `${result.closingRate.toDecimalString(6)}` +
        (result.averageRate === null
          ? ""
          : `, ${result.averageMethod} average ${result.averageRate.toDecimalString(6)} ` +
            `over ${result.period.from} to ${result.period.to}`),
    );
  }
  lines.push("-".repeat(width + 48));
  lines.push(
    "Account".padEnd(8) +
      "Name".padEnd(width + 2) +
      "Basis".padEnd(12) +
      "Debit".padStart(13) +
      "Credit".padStart(13),
  );
  for (const row of result.rows) {
    lines.push(
      row.account.padEnd(8) +
        row.name.padEnd(width + 2) +
        row.basis.padEnd(12) +
        (row.presentation.isPositive ? row.presentation.toDecimalString() : "").padStart(13) +
        (row.presentation.isNegative ? row.presentation.negated().toDecimalString() : "").padStart(13),
    );
  }
  if (!result.translationAdjustment.isZero) {
    const adjustment = result.translationAdjustment;
    lines.push(
      "".padEnd(8) +
        "Translation adjustment".padEnd(width + 2) +
        "residual".padEnd(12) +
        (adjustment.isPositive ? adjustment.toDecimalString() : "").padStart(13) +
        (adjustment.isNegative ? adjustment.negated().toDecimalString() : "").padStart(13),
    );
  }
  lines.push("-".repeat(width + 48));
  lines.push(
    "".padEnd(8) +
      "Total".padEnd(width + 2) +
      "".padEnd(12) +
      result.totalDebit.toDecimalString().padStart(13) +
      result.totalCredit.toDecimalString().padStart(13),
  );
  if (!result.balanced) {
    lines.push(`OUT BY ${result.totalDebit.minus(result.totalCredit).toDecimalString()}`);
  } else if (!result.translationAdjustment.isZero) {
    lines.push(
      "The adjustment is the accumulated effect of the rate having moved between",
      "the day each figure was recorded and the day the statement is read. It is",
      "an equity item, not a profit.",
    );
  }
  return lines.join("\n");
}
