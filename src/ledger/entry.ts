/**
 * Journal entries and the balancing invariant.
 *
 * The central rule of this file: an unbalanced `JournalEntry` cannot be
 * constructed. The check lives in the factory, the constructor is private, and
 * every field is frozen — so no code downstream of this module has to remember
 * to validate anything, and no code can un-balance an entry after the fact.
 *
 * Sign convention: a posting's amount is positive for a debit and negative for
 * a credit. One signed number is easier to sum than a (side, magnitude) pair,
 * and "the postings sum to zero" is then literally the invariant.
 */

import { Money, sumMoney } from "../money/money.js";
import type { Currency } from "../money/currency.js";
import type { ChartOfAccounts } from "../accounts/chart.js";
import { type CalendarDate, date as parseDate } from "./date.js";

export class UnbalancedEntryError extends Error {
  constructor(
    readonly residuals: readonly Money[],
    readonly narration: string,
  ) {
    const detail = residuals.map((r) => r.toString()).join(", ");
    super(`Entry "${narration}" does not balance; residual: ${detail}`);
    this.name = "UnbalancedEntryError";
  }
}

export class InvalidEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEntryError";
  }
}

export interface PostingInput {
  account: string;
  amount: Money;
  memo?: string;
  /**
   * The open item this line belongs to, when that is narrower than the entry's
   * own reference. See `Posting.reference`.
   */
  reference?: string;
  /**
   * What actually moved, when that was not in the currency the books are kept
   * in. See `Posting.foreign`.
   */
  foreign?: Money;
}

export interface Posting {
  readonly account: string;
  /** Positive is a debit, negative is a credit. */
  readonly amount: Money;
  readonly memo: string;
  /** Index within the entry, stable and used for deterministic ordering. */
  readonly index: number;
  /**
   * The open item this line belongs to, when the entry as a whole is about
   * more than one of them.
   *
   * A revaluation adjusts several invoices in a single entry, and each of its
   * postings belongs to a different one. Without this, the adjustment is
   * attributable to the account but not to the item, and settling one invoice
   * out of several would measure against what that invoice was originally
   * booked at rather than what it is now carried at — booking the same rate
   * movement once as unrealised and again as realised.
   *
   * Null means "whatever the entry says", which is the ordinary case.
   */
  readonly reference: string | null;
  /**
   * The transaction-currency amount, when the posting was denominated in
   * something other than the functional currency.
   *
   * `amount` is always the figure the books are kept in and always the one the
   * entry has to balance in — the invariant does not become "balances in every
   * currency at once", because it never was true of a real transaction. A euro
   * invoice is one economic event with two numbers attached: 1,000 EUR of
   * receivable, booked at 847.30 GBP. The second is what the trial balance
   * adds up; the first is what the customer owes and what a revaluation at the
   * close has to look at.
   *
   * Signs agree with `amount`. A debit of 847.30 GBP carrying a credit of
   * 1,000 EUR would be describing two different transactions.
   */
  readonly foreign: Money | null;
}

export interface JournalEntryInput {
  id: string;
  date: string;
  narration: string;
  postings: readonly PostingInput[];
  /** External reference: invoice number, statement line id, cheque number. */
  reference?: string;
  tags?: readonly string[];
  /** Set when this entry reverses another. */
  reverses?: string;
}

export class JournalEntry {
  readonly id: string;
  readonly date: CalendarDate;
  readonly narration: string;
  readonly postings: readonly Posting[];
  readonly reference: string | null;
  readonly tags: readonly string[];
  readonly reverses: string | null;

  private constructor(fields: {
    id: string;
    date: CalendarDate;
    narration: string;
    postings: readonly Posting[];
    reference: string | null;
    tags: readonly string[];
    reverses: string | null;
  }) {
    this.id = fields.id;
    this.date = fields.date;
    this.narration = fields.narration;
    this.postings = Object.freeze(fields.postings);
    this.reference = fields.reference;
    this.tags = Object.freeze(fields.tags);
    this.reverses = fields.reverses;
    Object.freeze(this);
  }

  /**
   * Build a validated entry. Throws unless:
   * - there are at least two postings,
   * - no posting is for zero,
   * - the postings sum to zero *within each currency*,
   * - and, when a chart is supplied, every account exists and is postable.
   */
  static create(input: JournalEntryInput, chart?: ChartOfAccounts): JournalEntry {
    if (input.id.trim() === "") throw new InvalidEntryError("Entry id must not be blank");
    if (input.narration.trim() === "") {
      throw new InvalidEntryError(`Entry ${input.id} must have a narration`);
    }
    if (input.postings.length < 2) {
      throw new InvalidEntryError(
        `Entry ${input.id} has ${input.postings.length} posting(s); at least 2 are required`,
      );
    }

    const when = parseDate(input.date);

    const postings: Posting[] = input.postings.map((p, index) => {
      if (p.amount.isZero) {
        throw new InvalidEntryError(
          `Entry ${input.id} posting ${index} to ${p.account} is for zero`,
        );
      }
      if (chart !== undefined) chart.assertPostable(p.account);
      const foreign = p.foreign ?? null;
      if (foreign !== null) {
        if (foreign.isZero) {
          throw new InvalidEntryError(
            `Entry ${input.id} posting ${index} to ${p.account} has a foreign amount of zero`,
          );
        }
        if (foreign.currency.code === p.amount.currency.code) {
          throw new InvalidEntryError(
            `Entry ${input.id} posting ${index} to ${p.account} gives a ${foreign.currency.code} ` +
              `amount as the foreign side of a ${p.amount.currency.code} posting`,
          );
        }
        if (foreign.sign !== p.amount.sign) {
          throw new InvalidEntryError(
            `Entry ${input.id} posting ${index} to ${p.account}: ${foreign.toString()} and ` +
              `${p.amount.toString()} are on opposite sides`,
          );
        }
        // An account's declared currency is what its foreign balance is in.
        // Letting a EUR posting land on a USD account would produce a balance
        // that no single closing rate can retranslate.
        const declared = chart?.find(p.account)?.currency;
        if (declared !== undefined && declared.code !== foreign.currency.code) {
          throw new InvalidEntryError(
            `Entry ${input.id} posting ${index}: account ${p.account} is denominated in ` +
              `${declared.code}, not ${foreign.currency.code}`,
          );
        }
      }
      return Object.freeze({
        account: p.account,
        amount: p.amount,
        memo: p.memo ?? "",
        index,
        reference: p.reference ?? null,
        foreign,
      });
    });

    const residuals = residualsByCurrency(postings.map((p) => p.amount));
    if (residuals.length > 0) throw new UnbalancedEntryError(residuals, input.narration);

    return new JournalEntry({
      id: input.id,
      date: when,
      narration: input.narration,
      postings,
      reference: input.reference ?? null,
      tags: Object.freeze([...(input.tags ?? [])]),
      reverses: input.reverses ?? null,
    });
  }

  /** Convenience for the overwhelmingly common two-line entry. */
  static simple(
    input: {
      id: string;
      date: string;
      narration: string;
      debit: string;
      credit: string;
      amount: Money;
      reference?: string;
      tags?: readonly string[];
    },
    chart?: ChartOfAccounts,
  ): JournalEntry {
    if (input.amount.isNegative) {
      throw new InvalidEntryError(
        `Entry ${input.id}: use a positive amount and name the debit and credit sides`,
      );
    }
    const create: JournalEntryInput = {
      id: input.id,
      date: input.date,
      narration: input.narration,
      postings: [
        { account: input.debit, amount: input.amount },
        { account: input.credit, amount: input.amount.negated() },
      ],
    };
    if (input.reference !== undefined) create.reference = input.reference;
    if (input.tags !== undefined) create.tags = input.tags;
    return JournalEntry.create(create, chart);
  }

  // ---------------------------------------------------------------- accessors

  get debits(): readonly Posting[] {
    return this.postings.filter((p) => p.amount.isPositive);
  }

  get credits(): readonly Posting[] {
    return this.postings.filter((p) => p.amount.isNegative);
  }

  get accounts(): readonly string[] {
    return [...new Set(this.postings.map((p) => p.account))];
  }

  get currencies(): readonly Currency[] {
    const seen = new Map<string, Currency>();
    for (const p of this.postings) seen.set(p.amount.currency.code, p.amount.currency);
    return [...seen.values()];
  }

  get isMultiCurrency(): boolean {
    return this.currencies.length > 1;
  }

  /** Postings that record something that happened in another currency. */
  get foreignPostings(): readonly Posting[] {
    return this.postings.filter((p) => p.foreign !== null);
  }

  get hasForeignAmounts(): boolean {
    return this.postings.some((p) => p.foreign !== null);
  }

  /** The transaction currencies this entry touches, deduplicated. */
  get foreignCurrencies(): readonly Currency[] {
    const seen = new Map<string, Currency>();
    for (const p of this.postings) {
      if (p.foreign !== null) seen.set(p.foreign.currency.code, p.foreign.currency);
    }
    return [...seen.values()];
  }

  /** Net foreign-currency effect on one account within this entry. */
  foreignAmountFor(account: string, currency: Currency | string): Money {
    const code = typeof currency === "string" ? currency.toUpperCase() : currency.code;
    return sumMoney(
      this.postings
        .filter((p) => p.account === account && p.foreign?.currency.code === code)
        .map((p) => p.foreign as Money),
      code,
    );
  }

  /** Total of the debit side in the given currency — the entry's "size". */
  total(currency?: Currency | string): Money {
    const code =
      currency === undefined
        ? (this.currencies[0] as Currency).code
        : typeof currency === "string"
          ? currency.toUpperCase()
          : currency.code;
    const matching = this.debits.filter((p) => p.amount.currency.code === code);
    return sumMoney(
      matching.map((p) => p.amount),
      code,
    );
  }

  /** The open item a posting belongs to: its own, or the entry's. */
  referenceFor(posting: Posting): string | null {
    return posting.reference ?? this.reference;
  }

  touches(account: string): boolean {
    return this.postings.some((p) => p.account === account);
  }

  /** Net effect on one account, summed across its postings in this entry. */
  amountFor(account: string, currency?: Currency | string): Money {
    const relevant = this.postings.filter((p) => p.account === account);
    const code =
      currency === undefined
        ? (relevant[0]?.amount.currency ?? (this.currencies[0] as Currency)).code
        : typeof currency === "string"
          ? currency.toUpperCase()
          : currency.code;
    return sumMoney(
      relevant.filter((p) => p.amount.currency.code === code).map((p) => p.amount),
      code,
    );
  }

  /** A mirror-image entry that undoes this one. */
  reversal(input: { id: string; date: string; narration?: string }): JournalEntry {
    return JournalEntry.create({
      id: input.id,
      date: input.date,
      narration: input.narration ?? `Reversal of ${this.narration}`,
      postings: this.postings.map((p) => ({
        account: p.account,
        amount: p.amount.negated(),
        memo: p.memo,
        ...(p.reference === null ? {} : { reference: p.reference }),
        ...(p.foreign === null ? {} : { foreign: p.foreign.negated() }),
      })),
      ...(this.reference !== null ? { reference: this.reference } : {}),
      tags: this.tags,
      reverses: this.id,
    });
  }

  toString(): string {
    const lines = this.postings.map((p) => {
      const base = `  ${p.account.padEnd(8)} ${p.amount.toDecimalString().padStart(12)}`;
      return p.foreign === null ? base : `${base}  (${p.foreign.toString()})`;
    });
    return [`${this.date} ${this.id} ${this.narration}`, ...lines].join("\n");
  }

  toJSON(): unknown {
    return {
      id: this.id,
      date: this.date,
      narration: this.narration,
      reference: this.reference,
      tags: this.tags,
      reverses: this.reverses,
      postings: this.postings.map((p) => ({
        account: p.account,
        amount: p.amount.toJSON(),
        memo: p.memo,
        reference: p.reference,
        foreign: p.foreign === null ? null : p.foreign.toJSON(),
      })),
    };
  }
}

/**
 * Per-currency sums that are not zero. An empty result means the set balances.
 * Exported because the ledger uses it to re-check invariants in bulk.
 */
export function residualsByCurrency(amounts: readonly Money[]): Money[] {
  const totals = new Map<string, Money>();
  for (const amount of amounts) {
    const code = amount.currency.code;
    const running = totals.get(code);
    totals.set(code, running === undefined ? amount : running.plus(amount));
  }
  return [...totals.values()].filter((m) => !m.isZero);
}

export function isBalanced(amounts: readonly Money[]): boolean {
  return residualsByCurrency(amounts).length === 0;
}
