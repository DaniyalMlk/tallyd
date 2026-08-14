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
}

export interface Posting {
  readonly account: string;
  /** Positive is a debit, negative is a credit. */
  readonly amount: Money;
  readonly memo: string;
  /** Index within the entry, stable and used for deterministic ordering. */
  readonly index: number;
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
      return Object.freeze({
        account: p.account,
        amount: p.amount,
        memo: p.memo ?? "",
        index,
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
      })),
      ...(this.reference !== null ? { reference: this.reference } : {}),
      tags: this.tags,
      reverses: this.id,
    });
  }

  toString(): string {
    const lines = this.postings.map(
      (p) => `  ${p.account.padEnd(8)} ${p.amount.toDecimalString().padStart(12)}`,
    );
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
