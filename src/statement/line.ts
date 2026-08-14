/**
 * A single line from a bank statement.
 *
 * Note what this is *not*: it is not a journal entry. A statement line is
 * someone else's record of what happened, and the whole reconciliation problem
 * exists because it disagrees with ours. So it keeps its own raw text, its own
 * sign convention (positive is money into the account), and the row it came
 * from, so a match can be explained by pointing at the source.
 */

import type { Money } from "../money/money.js";
import type { CalendarDate } from "../ledger/date.js";

export interface StatementLineInput {
  id: string;
  date: CalendarDate;
  /** Where the money actually settled, when the export distinguishes the two. */
  valueDate?: CalendarDate;
  description: string;
  amount: Money;
  balance?: Money;
  reference?: string;
  type?: string;
  /** Zero-based index in the source file, after the header. */
  sourceRow: number;
  raw?: Readonly<Record<string, string>>;
}

export interface StatementLine {
  readonly id: string;
  readonly date: CalendarDate;
  readonly valueDate: CalendarDate | null;
  readonly description: string;
  /** Positive is money in, negative is money out. */
  readonly amount: Money;
  readonly balance: Money | null;
  readonly reference: string | null;
  readonly type: string | null;
  readonly sourceRow: number;
  readonly raw: Readonly<Record<string, string>>;
  /** Description reduced to comparable form. */
  readonly normalisedDescription: string;
  /** Stable hash of date, amount and normalised description. */
  readonly fingerprint: string;
}

/**
 * Reduce a description to something comparable.
 *
 * Card descriptors carry a lot of noise that varies between otherwise
 * identical transactions: terminal ids, dates baked into the text, the `SQ *`
 * and `PAYPAL *` processor prefixes, and inconsistent spacing. Stripping them
 * is what lets two records of one purchase look alike.
 */
export function normaliseDescription(input: string): string {
  let text = input.toUpperCase();

  // Processor prefixes: "SQ *COFFEE", "PAYPAL *ACME", "IZ *SHOP".
  text = text.replace(/\b(SQ|PAYPAL|PP|IZ|TST|SP|WWW)\s*\*\s*/g, " ");

  // Card-scheme noise.
  text = text.replace(/\b(VISA|MASTERCARD|MAESTRO|DEBIT|CREDIT)\s+(CARD\s+)?(PAYMENT|PURCHASE)\b/g, " ");
  text = text.replace(/\bCARD\s+(PAYMENT|PURCHASE)\b/g, " ");
  text = text.replace(/\b(POS|ATM|CHQ|BGC|DD|SO|FPI|FPO|TFR)\b/g, " ");
  text = text.replace(/\bON\s+\d{1,2}[-/ ][A-Z]{3}[-/ ]?\d{0,4}\b/g, " ");

  // Dates and long digit runs baked into the descriptor.
  text = text.replace(/\b\d{1,2}[-/.]\d{1,2}([-/.]\d{2,4})?\b/g, " ");
  text = text.replace(/\b\d{6,}\b/g, " ");

  // Trailing terminal/reference numbers: "COFFEE 4471".
  text = text.replace(/\s+\d{2,6}\s*$/, " ");

  text = text.replace(/[^A-Z0-9 ]+/g, " ");
  text = text.replace(/\s+/g, " ").trim();

  return text;
}

/**
 * A short, stable hash. FNV-1a: not cryptographic, but deterministic across
 * runs and platforms, which is what a fingerprint needs to be.
 */
export function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function fingerprintOf(
  date: CalendarDate,
  amount: Money,
  normalisedDescription: string,
): string {
  return hashString(
    `${date}|${amount.currency.code}|${amount.minorUnits.toString()}|${normalisedDescription}`,
  );
}

export function statementLine(input: StatementLineInput): StatementLine {
  const normalisedDescription = normaliseDescription(input.description);
  return Object.freeze({
    id: input.id,
    date: input.date,
    valueDate: input.valueDate ?? null,
    description: input.description.trim(),
    amount: input.amount,
    balance: input.balance ?? null,
    reference: input.reference?.trim() ?? null,
    type: input.type?.trim() ?? null,
    sourceRow: input.sourceRow,
    raw: Object.freeze({ ...(input.raw ?? {}) }),
    normalisedDescription,
    fingerprint: fingerprintOf(input.date, input.amount, normalisedDescription),
  });
}

export function isMoneyIn(line: StatementLine): boolean {
  return line.amount.isPositive;
}

export function isMoneyOut(line: StatementLine): boolean {
  return line.amount.isNegative;
}
