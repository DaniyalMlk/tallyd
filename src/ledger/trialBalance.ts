/**
 * The trial balance — the report that proves the books are internally
 * consistent before anyone asks a harder question of them.
 *
 * Debits and credits are reported separately rather than as one signed net,
 * because the whole point of the report is to show the two columns agreeing.
 */

import { Money, sumMoney } from "../money/money.js";
import type { Currency } from "../money/currency.js";
import type { AccountType } from "../accounts/types.js";
import { debitSign } from "../accounts/types.js";
import type { CalendarDate } from "./date.js";
import type { Ledger } from "./ledger.js";

export interface TrialBalanceRow {
  readonly account: string;
  readonly name: string;
  readonly type: AccountType | null;
  /** The debit column: the net balance when it lands on the debit side. */
  readonly debit: Money;
  /** The credit column: the net balance when it lands on the credit side. */
  readonly credit: Money;
  readonly signed: Money;
  readonly postingCount: number;
}

export interface TrialBalance {
  readonly currency: Currency;
  readonly asAt: CalendarDate | null;
  readonly rows: readonly TrialBalanceRow[];
  readonly totalDebit: Money;
  readonly totalCredit: Money;
  /** totalDebit - totalCredit. Zero in a healthy ledger. */
  readonly difference: Money;
  readonly balanced: boolean;
}

export interface TrialBalanceOptions {
  currency?: Currency | string;
  asAt?: CalendarDate;
  /** Include accounts whose balance is zero. Off by default. */
  includeZero?: boolean;
}

export function trialBalance(ledger: Ledger, options: TrialBalanceOptions = {}): TrialBalance {
  const currencyCode =
    options.currency === undefined
      ? (ledger.currenciesUsed()[0] ?? ledger.chart?.defaultCurrency.code ?? "GBP")
      : typeof options.currency === "string"
        ? options.currency.toUpperCase()
        : options.currency.code;

  const rows: TrialBalanceRow[] = [];
  for (const account of ledger.activeAccounts()) {
    const detail = ledger.accountBalance(account, currencyCode);
    const signed =
      options.asAt === undefined
        ? detail.balance
        : ledger.balanceAsAt(account, options.asAt, currencyCode);

    if (signed.isZero && options.includeZero !== true) continue;

    const meta = ledger.chart?.find(account);
    rows.push(
      Object.freeze({
        account,
        name: meta?.name ?? account,
        type: meta?.type ?? null,
        debit: signed.isPositive ? signed : Money.zero(currencyCode),
        credit: signed.isNegative ? signed.negated() : Money.zero(currencyCode),
        signed,
        postingCount: detail.postingCount,
      }),
    );
  }

  rows.sort((a, b) => a.account.localeCompare(b.account));

  const totalDebit = sumMoney(
    rows.map((r) => r.debit),
    currencyCode,
  );
  const totalCredit = sumMoney(
    rows.map((r) => r.credit),
    currencyCode,
  );
  const difference = totalDebit.minus(totalCredit);

  return Object.freeze({
    currency: totalDebit.currency,
    asAt: options.asAt ?? null,
    rows: Object.freeze(rows),
    totalDebit,
    totalCredit,
    difference,
    balanced: difference.isZero,
  });
}

/** Totals by account type, read on each type's normal side. */
export function balancesByType(
  ledger: Ledger,
  options: TrialBalanceOptions = {},
): ReadonlyMap<AccountType, Money> {
  const tb = trialBalance(ledger, { ...options, includeZero: true });
  const totals = new Map<AccountType, Money>();
  for (const row of tb.rows) {
    if (row.type === null) continue;
    const natural = debitSign(row.type) === 1 ? row.signed : row.signed.negated();
    const running = totals.get(row.type);
    totals.set(row.type, running === undefined ? natural : running.plus(natural));
  }
  return totals;
}

/**
 * The accounting equation, stated as a residual: assets - liabilities - equity
 * - (income - expenses). Zero when the books hang together.
 */
export function equationResidual(ledger: Ledger, options: TrialBalanceOptions = {}): Money {
  const totals = balancesByType(ledger, options);
  const currencyCode =
    options.currency === undefined
      ? (ledger.currenciesUsed()[0] ?? "GBP")
      : typeof options.currency === "string"
        ? options.currency.toUpperCase()
        : options.currency.code;
  const zero = Money.zero(currencyCode);
  const assets = totals.get("asset") ?? zero;
  const liabilities = totals.get("liability") ?? zero;
  const equity = totals.get("equity") ?? zero;
  const income = totals.get("income") ?? zero;
  const expenses = totals.get("expense") ?? zero;
  return assets.minus(liabilities).minus(equity).minus(income.minus(expenses));
}

/** Fixed-width rendering, used by the CLI and in test failure messages. */
export function renderTrialBalance(tb: TrialBalance): string {
  const width = Math.max(20, ...tb.rows.map((r) => r.name.length));
  const lines: string[] = [];
  const heading = tb.asAt === null ? "Trial balance" : `Trial balance as at ${tb.asAt}`;
  lines.push(`${heading} (${tb.currency.code})`);
  lines.push("-".repeat(width + 34));
  lines.push(
    `${"Account".padEnd(8)}${"Name".padEnd(width + 2)}${"Debit".padStart(12)}${"Credit".padStart(12)}`,
  );
  for (const row of tb.rows) {
    lines.push(
      row.account.padEnd(8) +
        row.name.padEnd(width + 2) +
        (row.debit.isZero ? "" : row.debit.toDecimalString()).padStart(12) +
        (row.credit.isZero ? "" : row.credit.toDecimalString()).padStart(12),
    );
  }
  lines.push("-".repeat(width + 34));
  lines.push(
    "".padEnd(8) +
      "Total".padEnd(width + 2) +
      tb.totalDebit.toDecimalString().padStart(12) +
      tb.totalCredit.toDecimalString().padStart(12),
  );
  if (!tb.balanced) lines.push(`OUT BY ${tb.difference.toDecimalString()}`);
  return lines.join("\n");
}
