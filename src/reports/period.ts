/**
 * Movements over a period, as opposed to balances at a point in time.
 *
 * The distinction is the whole difference between the two primary statements.
 * A balance sheet asks "what is true right now", and the ledger already
 * answers that with `balanceAsAt`. A profit and loss account asks "what
 * happened between these two dates", which nothing answered until now.
 */

import { Money } from "../money/money.js";
import type { Currency } from "../money/currency.js";
import type { AccountType } from "../accounts/types.js";
import type { CalendarDate, DateRange } from "../ledger/date.js";
import { withinRange } from "../ledger/date.js";
import type { Ledger } from "../ledger/ledger.js";

export interface AccountMovement {
  readonly account: string;
  readonly name: string;
  readonly type: AccountType | null;
  /** Signed: positive is a net debit over the period. */
  readonly signed: Money;
  readonly debit: Money;
  readonly credit: Money;
  readonly postingCount: number;
}

export function resolveCurrency(ledger: Ledger, currency?: Currency | string): string {
  if (currency !== undefined) {
    return typeof currency === "string" ? currency.toUpperCase() : currency.code;
  }
  return ledger.currenciesUsed()[0] ?? ledger.chart?.defaultCurrency.code ?? "GBP";
}

/**
 * Every account that moved during `range`, with its debit and credit totals.
 *
 * Accounts that did not move are omitted rather than reported as zero: a P&L
 * listing forty accounts with nothing in them is harder to read, not more
 * complete.
 */
export function movementsIn(
  ledger: Ledger,
  range: DateRange,
  currencyCode: string,
): readonly AccountMovement[] {
  const debit = new Map<string, bigint>();
  const credit = new Map<string, bigint>();
  const counts = new Map<string, number>();

  for (const entry of ledger.all()) {
    if (!withinRange(entry.date, range)) continue;
    for (const posting of entry.postings) {
      if (posting.amount.currency.code !== currencyCode) continue;
      const minor = posting.amount.minorUnits;
      if (minor > 0n) debit.set(posting.account, (debit.get(posting.account) ?? 0n) + minor);
      else credit.set(posting.account, (credit.get(posting.account) ?? 0n) - minor);
      counts.set(posting.account, (counts.get(posting.account) ?? 0) + 1);
    }
  }

  const accounts = [...new Set([...debit.keys(), ...credit.keys()])].sort();
  return Object.freeze(
    accounts.map((account) => {
      const debitTotal = debit.get(account) ?? 0n;
      const creditTotal = credit.get(account) ?? 0n;
      const meta = ledger.chart?.find(account);
      return Object.freeze({
        account,
        name: meta?.name ?? account,
        type: meta?.type ?? null,
        signed: Money.ofMinor(debitTotal - creditTotal, currencyCode),
        debit: Money.ofMinor(debitTotal, currencyCode),
        credit: Money.ofMinor(creditTotal, currencyCode),
        postingCount: counts.get(account) ?? 0,
      });
    }),
  );
}

/** Balances of every posted account as at a date, signed (debit positive). */
export function balancesAsAt(
  ledger: Ledger,
  asAt: CalendarDate,
  currencyCode: string,
): ReadonlyMap<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const entry of ledger.all()) {
    if (entry.date > asAt) continue;
    for (const posting of entry.postings) {
      if (posting.amount.currency.code !== currencyCode) continue;
      totals.set(posting.account, (totals.get(posting.account) ?? 0n) + posting.amount.minorUnits);
    }
  }
  return totals;
}

/** Pad or truncate to an exact width, for fixed-column text reports. */
export function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}

export function amountColumn(value: Money, width = 13): string {
  return value.toDecimalString().padStart(width);
}
