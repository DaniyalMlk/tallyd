/**
 * The ledger, seen the way the bank sees it.
 *
 * A journal entry can touch six accounts; the bank only ever sees the one
 * posting that moved cash. Reconciliation compares like with like, so before
 * any matching happens the ledger is projected down to a flat list of cash
 * movements that carries the same sign convention as a statement line:
 * positive is money into the account.
 *
 * For an asset account that projection is the identity — a debit is money in —
 * but the conversion is done explicitly here rather than assumed, because the
 * same code has to work for a credit-card liability account where the signs
 * are the other way round.
 */

import type { Money } from "../money/money.js";
import type { CalendarDate, DateRange } from "../ledger/date.js";
import { withinRange } from "../ledger/date.js";
import type { Ledger } from "../ledger/ledger.js";
import type { JournalEntry, Posting } from "../ledger/entry.js";
import { normaliseDescription } from "../statement/line.js";

/** One cash movement in our own books, expressed in bank direction. */
export interface BookLine {
  /** `<entryId>#<postingIndex>`; unique within a view. */
  readonly id: string;
  readonly entryId: string;
  readonly postingIndex: number;
  readonly date: CalendarDate;
  readonly account: string;
  /** Positive is money in, matching `StatementLine.amount`. */
  readonly amount: Money;
  /** Narration, plus the posting memo when it adds anything. */
  readonly description: string;
  readonly normalisedDescription: string;
  readonly reference: string | null;
  /** The other side of the entry: where the money came from or went to. */
  readonly contraAccounts: readonly string[];
  /** Set when this entry reverses another. */
  readonly reverses: string | null;
  /** Set when a later entry reverses this one. */
  readonly reversedBy: string | null;
  readonly tags: readonly string[];
}

export interface BankViewOptions {
  /** Restrict to one currency. Defaults to every currency posted to the account. */
  currency?: string;
  /** Restrict to a date range, inclusive at both ends. */
  range?: DateRange;
  /**
   * Whether to keep entries that were later reversed, and the reversals
   * themselves. They net to nothing in the books but the bank may well have
   * seen both legs, so the default is to keep them.
   */
  includeReversed?: boolean;
  /**
   * `1` when a debit to this account is money in (an asset, the normal case),
   * `-1` for a liability such as a credit card. Defaults to `1`.
   */
  inflowSign?: 1 | -1;
}

function describe(entry: JournalEntry, posting: Posting): string {
  const memo = posting.memo.trim();
  if (memo === "" || memo === entry.narration) return entry.narration;
  return `${entry.narration} — ${memo}`;
}

/**
 * Every posting to one account, flattened into bank-direction cash movements
 * in chronological order.
 */
export function bankView(
  ledger: Ledger,
  account: string,
  options: BankViewOptions = {},
): readonly BookLine[] {
  const inflowSign = options.inflowSign ?? 1;
  const includeReversed = options.includeReversed ?? true;

  const entries = ledger.chronological();

  const reversedBy = new Map<string, string>();
  for (const entry of entries) {
    if (entry.reverses !== null) reversedBy.set(entry.reverses, entry.id);
  }

  const lines: BookLine[] = [];
  for (const entry of entries) {
    if (options.range !== undefined && !withinRange(entry.date, options.range)) continue;
    if (!includeReversed) {
      if (entry.reverses !== null) continue;
      if (reversedBy.has(entry.id)) continue;
    }
    for (const posting of entry.postings) {
      if (posting.account !== account) continue;
      if (
        options.currency !== undefined &&
        posting.amount.currency.code !== options.currency.toUpperCase()
      ) {
        continue;
      }
      const amount = inflowSign === 1 ? posting.amount : posting.amount.negated();
      const description = describe(entry, posting);
      lines.push(
        Object.freeze({
          id: `${entry.id}#${posting.index}`,
          entryId: entry.id,
          postingIndex: posting.index,
          date: entry.date,
          account,
          amount,
          description,
          normalisedDescription: normaliseDescription(description),
          reference: entry.reference,
          contraAccounts: Object.freeze(
            [...new Set(entry.postings.filter((p) => p.account !== account).map((p) => p.account))].sort(),
          ),
          reverses: entry.reverses,
          reversedBy: reversedBy.get(entry.id) ?? null,
          tags: entry.tags,
        }),
      );
    }
  }

  return Object.freeze(lines);
}

/** Net movement across a set of book lines. Every line must share a currency. */
export function bookLineTotal(lines: readonly BookLine[]): bigint {
  let total = 0n;
  for (const line of lines) total += line.amount.minorUnits;
  return total;
}

export function isMoneyInBook(line: BookLine): boolean {
  return line.amount.isPositive;
}

export function isMoneyOutBook(line: BookLine): boolean {
  return line.amount.isNegative;
}
