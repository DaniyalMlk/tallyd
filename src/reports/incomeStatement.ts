/**
 * The profit and loss account.
 *
 * Two decisions shape this report. First, income and expense figures are
 * reported as positive magnitudes on their natural side rather than as signed
 * balances — an expense of £1,850 reads as `1850.00`, not `-1850.00`, because
 * the sign is already carried by which section it sits in, and printing it
 * twice is how a reader ends up subtracting something that was already
 * negative.
 *
 * Second, a comparative period is a first-class part of the report rather than
 * an afterthought. A P&L with nothing beside it is a number without a
 * direction: £6,480 of income means nothing until you know last month was
 * £4,000 or £9,000. When a comparative is supplied, every line carries its
 * prior figure and the movement between them.
 */

import { Money } from "../money/money.js";
import type { Currency } from "../money/currency.js";
import { currency as lookupCurrency } from "../money/currency.js";
import type { DateRange } from "../ledger/date.js";
import type { Ledger } from "../ledger/ledger.js";
import { amountColumn, movementsIn, pad, resolveCurrency } from "./period.js";

export interface IncomeStatementRow {
  readonly account: string;
  readonly name: string;
  /** Positive on the account's natural side. */
  readonly amount: Money;
  /** The same line in the comparative period, or null when there is none. */
  readonly comparative: Money | null;
  /** `amount - comparative`, or null. */
  readonly movement: Money | null;
}

export interface IncomeStatementSection {
  readonly rows: readonly IncomeStatementRow[];
  readonly total: Money;
  readonly comparativeTotal: Money | null;
}

export interface IncomeStatement {
  readonly currency: Currency;
  readonly period: DateRange;
  readonly comparativePeriod: DateRange | null;
  readonly income: IncomeStatementSection;
  readonly expenses: IncomeStatementSection;
  /** Income less expenses. Negative is a loss. */
  readonly netResult: Money;
  readonly comparativeNetResult: Money | null;
}

export interface IncomeStatementOptions {
  currency?: Currency | string;
  /** A prior period to report alongside. */
  comparative?: DateRange;
  /** Include accounts with no movement. Off by default. */
  includeZero?: boolean;
}

function sectionFor(
  ledger: Ledger,
  period: DateRange,
  comparative: DateRange | null,
  currencyCode: string,
  type: "income" | "expense",
  includeZero: boolean,
): IncomeStatementSection {
  // Income sits on the credit side, expenses on the debit side; both are
  // reported as positive magnitudes, so the sign flip happens exactly here.
  const naturalSign = type === "income" ? -1n : 1n;

  const current = movementsIn(ledger, period, currencyCode).filter((m) => m.type === type);
  const prior =
    comparative === null
      ? null
      : new Map(
          movementsIn(ledger, comparative, currencyCode)
            .filter((m) => m.type === type)
            .map((m) => [m.account, m.signed.minorUnits * naturalSign] as const),
        );

  const accounts = new Set(current.map((m) => m.account));
  if (prior !== null) for (const account of prior.keys()) accounts.add(account);

  const rows: IncomeStatementRow[] = [];
  for (const account of [...accounts].sort()) {
    const movement = current.find((m) => m.account === account);
    const amountMinor = (movement?.signed.minorUnits ?? 0n) * naturalSign;
    // An account that moved in only one of the two periods still gets a
    // figure in both columns. Leaving the other blank makes the column stop
    // adding up, which is a worse thing for a reader to discover than a zero.
    const comparativeMinor = prior === null ? null : (prior.get(account) ?? 0n);

    if (!includeZero && amountMinor === 0n && (comparativeMinor ?? 0n) === 0n) continue;

    rows.push(
      Object.freeze({
        account,
        name: movement?.name ?? ledger.chart?.find(account)?.name ?? account,
        amount: Money.ofMinor(amountMinor, currencyCode),
        comparative:
          comparativeMinor === null ? null : Money.ofMinor(comparativeMinor, currencyCode),
        movement:
          comparativeMinor === null
            ? null
            : Money.ofMinor(amountMinor - comparativeMinor, currencyCode),
      }),
    );
  }

  const total = Money.ofMinor(
    rows.reduce((sum, row) => sum + row.amount.minorUnits, 0n),
    currencyCode,
  );
  const comparativeTotal =
    comparative === null
      ? null
      : Money.ofMinor(
          rows.reduce((sum, row) => sum + (row.comparative?.minorUnits ?? 0n), 0n),
          currencyCode,
        );

  return Object.freeze({ rows: Object.freeze(rows), total, comparativeTotal });
}

export function incomeStatement(
  ledger: Ledger,
  period: DateRange,
  options: IncomeStatementOptions = {},
): IncomeStatement {
  const currencyCode = resolveCurrency(ledger, options.currency);
  const comparative = options.comparative ?? null;
  const includeZero = options.includeZero ?? false;

  const income = sectionFor(ledger, period, comparative, currencyCode, "income", includeZero);
  const expenses = sectionFor(ledger, period, comparative, currencyCode, "expense", includeZero);

  return Object.freeze({
    currency: lookupCurrency(currencyCode),
    period,
    comparativePeriod: comparative,
    income,
    expenses,
    netResult: income.total.minus(expenses.total),
    comparativeNetResult:
      income.comparativeTotal === null || expenses.comparativeTotal === null
        ? null
        : income.comparativeTotal.minus(expenses.comparativeTotal),
  });
}

/**
 * The result for a period, without building the whole report. The balance
 * sheet needs this figure to fold into equity.
 */
export function netResultFor(
  ledger: Ledger,
  period: DateRange,
  currency?: Currency | string,
): Money {
  const currencyCode = resolveCurrency(ledger, currency);
  let income = 0n;
  let expense = 0n;
  for (const movement of movementsIn(ledger, period, currencyCode)) {
    // Income is a credit balance, so its natural magnitude is the negated
    // signed movement; expenses are already on the debit side.
    if (movement.type === "income") income -= movement.signed.minorUnits;
    else if (movement.type === "expense") expense += movement.signed.minorUnits;
  }
  return Money.ofMinor(income - expense, currencyCode);
}

const NAME_WIDTH = 34;

function renderSection(
  title: string,
  section: IncomeStatementSection,
  withComparative: boolean,
): string[] {
  const out: string[] = [title];
  for (const row of section.rows) {
    const line = `  ${pad(`${row.account}  ${row.name}`, NAME_WIDTH)}${amountColumn(row.amount)}`;
    out.push(
      withComparative && row.comparative !== null
        ? `${line}${amountColumn(row.comparative)}${amountColumn(row.movement as Money)}`
        : line,
    );
  }
  const totalLine = `  ${pad(`Total ${title.toLowerCase()}`, NAME_WIDTH)}${amountColumn(section.total)}`;
  out.push(
    withComparative && section.comparativeTotal !== null
      ? `${totalLine}${amountColumn(section.comparativeTotal)}${amountColumn(section.total.minus(section.comparativeTotal))}`
      : totalLine,
  );
  return out;
}

export function renderIncomeStatement(statement: IncomeStatement): string {
  const withComparative = statement.comparativePeriod !== null;
  const width = withComparative ? 76 : 50;

  const out: string[] = [];
  out.push(
    `Income statement (${statement.currency.code})  ${statement.period.from} to ${statement.period.to}`,
  );
  if (withComparative) {
    const prior = statement.comparativePeriod as DateRange;
    out.push(`  comparative period: ${prior.from} to ${prior.to}`);
    out.push(
      `${" ".repeat(NAME_WIDTH + 2)}${"period".padStart(13)}${"prior".padStart(13)}${"movement".padStart(13)}`,
    );
  }
  out.push("=".repeat(width));

  out.push(...renderSection("Income", statement.income, withComparative));
  out.push("");
  out.push(...renderSection("Expenses", statement.expenses, withComparative));
  out.push("-".repeat(width));

  const label = statement.netResult.isNegative ? "Loss for the period" : "Profit for the period";
  const resultLine = `  ${pad(label, NAME_WIDTH)}${amountColumn(statement.netResult)}`;
  out.push(
    withComparative && statement.comparativeNetResult !== null
      ? `${resultLine}${amountColumn(statement.comparativeNetResult)}${amountColumn(statement.netResult.minus(statement.comparativeNetResult))}`
      : resultLine,
  );

  return out.join("\n");
}
