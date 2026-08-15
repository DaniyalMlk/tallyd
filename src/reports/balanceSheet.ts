/**
 * The balance sheet.
 *
 * The trap here is not the arithmetic, it is the period result. Income and
 * expense accounts have not been closed out to retained earnings — this ledger
 * is append-only and never rewrites history, so nothing has been closed at
 * all. Report equity as it stands in the accounts and the statement will be
 * out by exactly the profit for the period, every time.
 *
 * So the result is folded in explicitly, as its own line in equity. It is not
 * a fudge to make the two sides agree: it is what closing entries would post
 * if they existed, and stating it as a visible line is more honest than
 * silently absorbing it into a total. The identity underneath is the one that
 * falls straight out of double entry — every signed balance sums to zero, so
 * assets equal liabilities plus equity plus (income less expenses).
 */

import { Money } from "../money/money.js";
import type { Currency } from "../money/currency.js";
import { currency as lookupCurrency } from "../money/currency.js";
import type { AccountType } from "../accounts/types.js";
import { debitSign } from "../accounts/types.js";
import type { CalendarDate } from "../ledger/date.js";
import { dateRange } from "../ledger/date.js";
import type { Ledger } from "../ledger/ledger.js";
import { netResultFor } from "./incomeStatement.js";
import { amountColumn, balancesAsAt, pad, resolveCurrency } from "./period.js";

export interface BalanceSheetRow {
  readonly account: string;
  readonly name: string;
  /** Positive on the account's natural side. */
  readonly amount: Money;
  /** True for the synthesised result-for-the-period line. */
  readonly synthetic: boolean;
}

export interface BalanceSheetSection {
  readonly rows: readonly BalanceSheetRow[];
  readonly total: Money;
}

export interface BalanceSheet {
  readonly currency: Currency;
  readonly asAt: CalendarDate;
  readonly assets: BalanceSheetSection;
  readonly liabilities: BalanceSheetSection;
  readonly equity: BalanceSheetSection;
  /** Income less expenses up to `asAt`, folded into equity. */
  readonly resultForPeriod: Money;
  readonly totalLiabilitiesAndEquity: Money;
  /** Assets less liabilities and equity. Zero in a healthy ledger. */
  readonly difference: Money;
  readonly balanced: boolean;
}

export interface BalanceSheetOptions {
  currency?: Currency | string;
  /** Include accounts whose balance is zero. Off by default. */
  includeZero?: boolean;
  /**
   * Where the period result is posted. Defaults to `"3200"` when the chart
   * has it, otherwise the line stands alone under equity.
   */
  retainedEarningsAccount?: string;
}

const EPOCH_START = "0001-01-01";

function sectionFor(
  ledger: Ledger,
  balances: ReadonlyMap<string, bigint>,
  type: AccountType,
  currencyCode: string,
  includeZero: boolean,
): BalanceSheetSection {
  const sign = BigInt(debitSign(type));
  const rows: BalanceSheetRow[] = [];

  for (const [account, signed] of [...balances].sort(([a], [b]) => a.localeCompare(b))) {
    const meta = ledger.chart?.find(account);
    if (meta?.type !== type) continue;
    const amount = signed * sign;
    if (amount === 0n && !includeZero) continue;
    rows.push(
      Object.freeze({
        account,
        name: meta.name,
        amount: Money.ofMinor(amount, currencyCode),
        synthetic: false,
      }),
    );
  }

  return Object.freeze({
    rows: Object.freeze(rows),
    total: Money.ofMinor(
      rows.reduce((sum, row) => sum + row.amount.minorUnits, 0n),
      currencyCode,
    ),
  });
}

export function balanceSheet(
  ledger: Ledger,
  asAt: CalendarDate,
  options: BalanceSheetOptions = {},
): BalanceSheet {
  const currencyCode = resolveCurrency(ledger, options.currency);
  const includeZero = options.includeZero ?? false;
  const balances = balancesAsAt(ledger, asAt, currencyCode);

  const assets = sectionFor(ledger, balances, "asset", currencyCode, includeZero);
  const liabilities = sectionFor(ledger, balances, "liability", currencyCode, includeZero);
  const bookedEquity = sectionFor(ledger, balances, "equity", currencyCode, includeZero);

  const resultForPeriod = netResultFor(ledger, dateRange(EPOCH_START, asAt), currencyCode);

  const equityRows: BalanceSheetRow[] = [
    ...bookedEquity.rows,
    Object.freeze({
      account: options.retainedEarningsAccount ?? "",
      name: resultForPeriod.isNegative ? "Loss for the period" : "Result for the period",
      amount: resultForPeriod,
      synthetic: true,
    }),
  ];

  const equity: BalanceSheetSection = Object.freeze({
    rows: Object.freeze(equityRows),
    total: bookedEquity.total.plus(resultForPeriod),
  });

  const totalLiabilitiesAndEquity = liabilities.total.plus(equity.total);
  const difference = assets.total.minus(totalLiabilitiesAndEquity);

  return Object.freeze({
    currency: lookupCurrency(currencyCode),
    asAt,
    assets,
    liabilities,
    equity,
    resultForPeriod,
    totalLiabilitiesAndEquity,
    difference,
    balanced: difference.isZero,
  });
}

const NAME_WIDTH = 36;

function renderSection(title: string, section: BalanceSheetSection): string[] {
  const out: string[] = [title];
  for (const row of section.rows) {
    const label = row.account === "" ? row.name : `${row.account}  ${row.name}`;
    out.push(`  ${pad(row.synthetic ? `${label} *` : label, NAME_WIDTH)}${amountColumn(row.amount)}`);
  }
  out.push(`  ${pad(`Total ${title.toLowerCase()}`, NAME_WIDTH)}${amountColumn(section.total)}`);
  return out;
}

export function renderBalanceSheet(sheet: BalanceSheet): string {
  const out: string[] = [];
  out.push(`Balance sheet (${sheet.currency.code}) as at ${sheet.asAt}`);
  out.push("=".repeat(52));
  out.push(...renderSection("Assets", sheet.assets));
  out.push("");
  out.push(...renderSection("Liabilities", sheet.liabilities));
  out.push("");
  out.push(...renderSection("Equity", sheet.equity));
  out.push("-".repeat(52));
  out.push(`  ${pad("Liabilities and equity", NAME_WIDTH)}${amountColumn(sheet.totalLiabilitiesAndEquity)}`);
  out.push(
    `  ${pad(sheet.balanced ? "Balanced" : "OUT OF BALANCE", NAME_WIDTH)}${amountColumn(sheet.difference)}`,
  );
  out.push("");
  out.push("  * income and expenses have not been closed out, so the period result");
  out.push("    is folded into equity here rather than sitting in retained earnings.");
  return out.join("\n");
}
