/**
 * Closing the books at a date.
 *
 * A year end has a step nothing in this library has needed until now: the
 * income and expense accounts are emptied into reserves, so that they start the
 * next year at nil and the balance sheet carries what was earned. It is
 * mechanical, and for a company keeping its own books it is a housekeeping
 * task. It becomes interesting in a group.
 *
 * A consolidation reads an entity's result as the balance on its income
 * accounts at the reporting date. That is right for books closed at each year
 * end, where the balance is exactly the year's result, and wrong in two
 * situations that are not unusual. A company acquired in March has twelve
 * months on its income accounts and only nine of them belong to the group. A
 * company that has never closed its books has every year since it was formed
 * on them. In both cases the fix is the same: close the books at the date the
 * period of interest begins, and what is left on the income accounts is the
 * period's result and nothing else.
 *
 * Two things about how it is done here.
 *
 * It is an entry, not an adjustment. The same rule the rest of the library
 * follows: if a figure changed, there is a balanced journal entry with a
 * narration that changed it, and a reader can find it. A closing pass that
 * quietly rewrote balances would be the one operation in the system that could
 * not be audited.
 *
 * And it returns a new ledger rather than mutating one. An entity's books are
 * not the group's to rewrite: the group needs a view of them closed at a date
 * for its own purposes, and the file on disk is unchanged. The append-only
 * ledger makes that free.
 */

import { Money } from "../money/money.js";
import type { Currency } from "../money/currency.js";
import type { CalendarDate } from "./date.js";
import { date as parseDate } from "./date.js";
import { JournalEntry, type PostingInput } from "./entry.js";
import { Ledger } from "./ledger.js";
import { trialBalance } from "./trialBalance.js";

export class CloseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloseError";
  }
}

export interface CloseOptions {
  /** Where the result goes. Retained earnings by default. */
  reserves?: string;
  /** The entry's id. One is derived from the date when this is not given. */
  id?: string;
  narration?: string;
  /** Which currency's balances to close. Defaults to the ledger's first. */
  currency?: Currency | string;
  tags?: readonly string[];
}

/**
 * The entry that closes the income and expense accounts as at a date.
 *
 * Null when there is nothing to close, which is the ordinary case for a ledger
 * already closed at that date and for one that has not traded yet. A caller
 * that wants an entry either way would be asking for an unbalanced one.
 */
export function closingEntry(
  ledger: Ledger,
  asAt: CalendarDate | string,
  options: CloseOptions = {},
): JournalEntry | null {
  const when = parseDate(String(asAt));
  const currencyCode =
    options.currency === undefined
      ? (ledger.currenciesUsed()[0] ?? ledger.chart?.defaultCurrency.code ?? "GBP")
      : typeof options.currency === "string"
        ? options.currency.toUpperCase()
        : options.currency.code;
  const reserves = options.reserves ?? "3200";

  const balances = trialBalance(ledger, { currency: currencyCode, asAt: when });
  const postings: PostingInput[] = [];
  let total = Money.zero(currencyCode);
  for (const row of balances.rows) {
    if (row.type !== "income" && row.type !== "expense") continue;
    if (row.account === reserves) continue;
    if (row.signed.isZero) continue;
    postings.push({
      account: row.account,
      amount: row.signed.negated(),
      memo: `closed at ${when}`,
    });
    total = total.plus(row.signed);
  }
  if (postings.length === 0) return null;
  if (total.isZero) {
    // Income and expenses that cancel exactly. There is still something to
    // close — both sides have to come off — but no result to carry across, so
    // the reserves line would be for zero and entries reject zero postings.
    return JournalEntry.create(
      {
        id: options.id ?? `CLOSE-${when}`,
        date: String(when),
        narration: options.narration ?? `Result to ${when} closed to reserves`,
        postings,
        tags: options.tags ?? ["close"],
      },
      ledger.chart,
    );
  }
  postings.push({
    account: reserves,
    amount: total,
    memo: `result to ${when}`,
  });

  return JournalEntry.create(
    {
      id: options.id ?? `CLOSE-${when}`,
      date: String(when),
      narration: options.narration ?? `Result to ${when} closed to reserves`,
      postings,
      tags: options.tags ?? ["close"],
    },
    ledger.chart,
  );
}

/**
 * The same books, with the result to a date taken to reserves.
 *
 * The original ledger is untouched. Where there is nothing to close the same
 * ledger comes back, so this is safe to call on books that are already closed
 * and cheap to call when it turns out not to be needed.
 */
export function withResultClosed(
  ledger: Ledger,
  asAt: CalendarDate | string,
  options: CloseOptions = {},
): Ledger {
  const entry = closingEntry(ledger, asAt, options);
  if (entry === null) return ledger;
  if (ledger.has(entry.id)) {
    // The ledger would reject the duplicate id anyway. Saying which operation
    // collided is more use than a bare id clash from somewhere further down.
    throw new CloseError(
      `These books already carry an entry ${entry.id}, so they have been closed at ` +
        `${asAt} once already. Pass a different id if that is not what happened.`,
    );
  }
  return ledger.post(entry);
}

/**
 * What an entity earned over a window, read off books closed at its start.
 *
 * This is the figure a consolidation wants when an entity was controlled for
 * part of the period: the income and expense balances at the reporting date,
 * on books closed the day the window opens. Returned as a credit-positive
 * figure, the way a result reads.
 */
export function resultOver(
  ledger: Ledger,
  from: CalendarDate | string,
  to: CalendarDate | string,
  options: CloseOptions = {},
): Money {
  const closed = withResultClosed(ledger, from, options);
  const currencyCode =
    options.currency === undefined
      ? (ledger.currenciesUsed()[0] ?? ledger.chart?.defaultCurrency.code ?? "GBP")
      : typeof options.currency === "string"
        ? options.currency.toUpperCase()
        : options.currency.code;
  const balances = trialBalance(closed, { currency: currencyCode, asAt: parseDate(String(to)) });
  return balances.rows
    .filter((row) => row.type === "income" || row.type === "expense")
    .reduce((running, row) => running.plus(row.signed), Money.zero(currencyCode))
    .negated();
}
