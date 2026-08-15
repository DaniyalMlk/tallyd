/**
 * Ageing: who owes what, and for how long.
 *
 * The report needs a concept the ledger does not have — an *open item*. A
 * receivables account is not a list of debts, it is a list of postings, some
 * of which cancel others out. So postings are grouped by their external
 * reference (the invoice number), netted within each group, and the groups
 * that do not net to zero are what remains outstanding.
 *
 * Grouping by reference rather than by counterparty is deliberate. Two
 * invoices to the same customer age separately, because they were raised on
 * different days and one may be current while the other is ninety days past
 * due. Rolling them together would hide exactly the item worth chasing.
 *
 * An item is aged from the date of its *earliest* posting — when the invoice
 * was raised — not from the last time anything touched it. A part payment
 * received today does not make a sixty-day-old debt current.
 */

import { Money } from "../money/money.js";
import type { Currency } from "../money/currency.js";
import { currency as lookupCurrency } from "../money/currency.js";
import { debitSign } from "../accounts/types.js";
import type { CalendarDate } from "../ledger/date.js";
import { daysBetween } from "../ledger/date.js";
import type { Ledger } from "../ledger/ledger.js";
import { amountColumn, pad, resolveCurrency } from "./period.js";

export interface OpenItem {
  /** The invoice number, or the entry id when nothing else identifies it. */
  readonly reference: string;
  readonly account: string;
  /** When the item was raised — its earliest posting. */
  readonly raised: CalendarDate;
  /** The last time anything touched it. */
  readonly lastMovement: CalendarDate;
  /** Outstanding amount, positive on the account's natural side. */
  readonly outstanding: Money;
  /** What was originally raised, before any part payments. */
  readonly raisedAmount: Money;
  readonly daysOutstanding: number;
  readonly narration: string;
  readonly entryIds: readonly string[];
}

export interface AgeingBucket {
  readonly label: string;
  /** Inclusive lower bound in days. */
  readonly from: number;
  /** Inclusive upper bound, or null for the open-ended final bucket. */
  readonly to: number | null;
  readonly items: readonly OpenItem[];
  readonly total: Money;
}

export interface Ageing {
  readonly currency: Currency;
  readonly account: string;
  readonly accountName: string;
  readonly asAt: CalendarDate;
  readonly buckets: readonly AgeingBucket[];
  readonly items: readonly OpenItem[];
  readonly total: Money;
}

export interface AgeingOptions {
  currency?: Currency | string;
  /** Upper bounds of each bucket except the last. Defaults to 30 / 60 / 90. */
  boundaries?: readonly number[];
  /** Items smaller than this in minor units are ignored. Defaults to 0. */
  minimumMinorUnits?: bigint;
}

const DEFAULT_BOUNDARIES: readonly number[] = [30, 60, 90];

/**
 * Outstanding items on one account as at a date.
 *
 * The sign convention follows the account: a receivable is a debit balance and
 * a payable a credit one, and both are reported as positive amounts owed. An
 * item that has flipped past zero — an overpayment — keeps its negative sign,
 * because a credit sitting on a customer's account is real and hiding it would
 * be worse than reporting it oddly.
 */
export function openItems(
  ledger: Ledger,
  account: string,
  asAt: CalendarDate,
  options: AgeingOptions = {},
): readonly OpenItem[] {
  const currencyCode = resolveCurrency(ledger, options.currency);
  const type = ledger.chart?.find(account)?.type;
  const sign = BigInt(type === undefined ? 1 : debitSign(type));
  const minimum = options.minimumMinorUnits ?? 0n;

  interface Group {
    reference: string;
    raised: CalendarDate;
    lastMovement: CalendarDate;
    net: bigint;
    raisedAmount: bigint;
    narration: string;
    entryIds: string[];
  }

  const groups = new Map<string, Group>();

  for (const entry of ledger.chronological()) {
    if (entry.date > asAt) continue;
    for (const posting of entry.postings) {
      if (posting.account !== account) continue;
      if (posting.amount.currency.code !== currencyCode) continue;

      const key = entry.reference ?? entry.id;
      const amount = posting.amount.minorUnits * sign;
      const existing = groups.get(key);

      if (existing === undefined) {
        groups.set(key, {
          reference: key,
          raised: entry.date,
          lastMovement: entry.date,
          net: amount,
          raisedAmount: amount > 0n ? amount : 0n,
          narration: entry.narration,
          entryIds: [entry.id],
        });
        continue;
      }

      existing.net += amount;
      if (amount > 0n) existing.raisedAmount += amount;
      if (entry.date < existing.raised) existing.raised = entry.date;
      if (entry.date > existing.lastMovement) existing.lastMovement = entry.date;
      if (!existing.entryIds.includes(entry.id)) existing.entryIds.push(entry.id);
    }
  }

  const items: OpenItem[] = [];
  for (const group of groups.values()) {
    const magnitude = group.net < 0n ? -group.net : group.net;
    if (magnitude <= minimum) continue;
    items.push(
      Object.freeze({
        reference: group.reference,
        account,
        raised: group.raised,
        lastMovement: group.lastMovement,
        outstanding: Money.ofMinor(group.net, currencyCode),
        raisedAmount: Money.ofMinor(group.raisedAmount, currencyCode),
        daysOutstanding: daysBetween(group.raised, asAt),
        narration: group.narration,
        entryIds: Object.freeze([...group.entryIds]),
      }),
    );
  }

  items.sort((a, b) =>
    a.raised === b.raised ? a.reference.localeCompare(b.reference) : a.raised < b.raised ? -1 : 1,
  );
  return Object.freeze(items);
}

function bucketsFrom(boundaries: readonly number[]): { label: string; from: number; to: number | null }[] {
  const sorted = [...new Set(boundaries)].sort((a, b) => a - b);
  const out: { label: string; from: number; to: number | null }[] = [];
  let from = 0;
  for (const boundary of sorted) {
    out.push({ label: from === 0 ? `0-${boundary}` : `${from}-${boundary}`, from, to: boundary });
    from = boundary + 1;
  }
  out.push({ label: `${from}+`, from, to: null });
  return out;
}

export function ageing(
  ledger: Ledger,
  account: string,
  asAt: CalendarDate,
  options: AgeingOptions = {},
): Ageing {
  const currencyCode = resolveCurrency(ledger, options.currency);
  const items = openItems(ledger, account, asAt, options);
  const shape = bucketsFrom(options.boundaries ?? DEFAULT_BOUNDARIES);

  const buckets: AgeingBucket[] = shape.map((bucket) => {
    const inBucket = items.filter(
      (item) =>
        item.daysOutstanding >= bucket.from &&
        (bucket.to === null || item.daysOutstanding <= bucket.to),
    );
    return Object.freeze({
      label: bucket.label,
      from: bucket.from,
      to: bucket.to,
      items: Object.freeze(inBucket),
      total: Money.ofMinor(
        inBucket.reduce((sum, item) => sum + item.outstanding.minorUnits, 0n),
        currencyCode,
      ),
    });
  });

  return Object.freeze({
    currency: lookupCurrency(currencyCode),
    account,
    accountName: ledger.chart?.find(account)?.name ?? account,
    asAt,
    buckets: Object.freeze(buckets),
    items,
    total: Money.ofMinor(
      items.reduce((sum, item) => sum + item.outstanding.minorUnits, 0n),
      currencyCode,
    ),
  });
}

export function renderAgeing(report: Ageing): string {
  const out: string[] = [];
  out.push(
    `Ageing — ${report.account} ${report.accountName} (${report.currency.code}) as at ${report.asAt}`,
  );
  out.push("=".repeat(74));

  if (report.items.length === 0) {
    out.push("  Nothing outstanding.");
    return out.join("\n");
  }

  out.push(
    `  ${pad("Reference", 16)}${pad("Raised", 12)}${pad("Days", 6)}${pad("Detail", 26)}${"Outstanding".padStart(13)}`,
  );
  for (const item of report.items) {
    out.push(
      `  ${pad(item.reference, 16)}${pad(item.raised, 12)}${pad(String(item.daysOutstanding), 6)}` +
        `${pad(item.narration, 26)}${amountColumn(item.outstanding)}`,
    );
  }

  out.push("-".repeat(74));
  const header = report.buckets.map((bucket) => bucket.label.padStart(13)).join("");
  out.push(`  ${pad("", 16)}${header}`);
  out.push(
    `  ${pad("Outstanding", 16)}${report.buckets.map((bucket) => amountColumn(bucket.total)).join("")}`,
  );
  out.push(`  ${pad("Total", 16)}${amountColumn(report.total)}`);
  return out.join("\n");
}
