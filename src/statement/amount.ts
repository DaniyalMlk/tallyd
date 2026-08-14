/**
 * Parsing the amount column, which every bank formats differently.
 *
 * Observed in the wild, all meaning the same thing:
 *
 *     -1,234.56    (1,234.56)    1.234,56-    £1,234.56 DR    1234.56CR
 *
 * The hard part is not the symbols, it is deciding whether `1.234` is one
 * thousand two hundred and thirty four, or one point two three four. That
 * cannot be settled per value — only by looking at the whole column.
 */

import { Money } from "../money/money.js";
import type { Currency } from "../money/currency.js";
import type { RoundingMode } from "../money/rounding.js";

export type DecimalConvention = "dot" | "comma";

export class AmountParseError extends Error {
  constructor(readonly input: string, reason: string) {
    super(`Cannot read ${JSON.stringify(input)} as an amount: ${reason}`);
    this.name = "AmountParseError";
  }
}

const CURRENCY_SYMBOLS = /[£$€¥₹]|GBP|USD|EUR|JPY|CHF|CAD|AUD|KWD/gi;

/**
 * Normalise the decorations around a number, returning the bare digits, the
 * separators and whether the value is negative.
 */
function strip(input: string): { body: string; negative: boolean } {
  let text = input.trim();
  if (text === "") throw new AmountParseError(input, "it is empty");

  let negative = false;

  // Accounting parentheses: (45.00) is negative forty five.
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }

  // Trailing or leading DR/CR markers. CR is a credit: money in, so positive
  // in the statement's own sign convention; DR is money out. No word boundary
  // is required on the digit side, because "1234.56CR" is written unspaced.
  const trailing = /(DR|CR)\s*$/i.exec(text);
  const leading = /^\s*(DR|CR)/i.exec(text);
  const marker = (trailing?.[1] ?? leading?.[1] ?? "").toUpperCase();
  if (marker !== "") {
    if (marker === "DR") negative = true;
    text = text
      .replace(/^\s*(DR|CR)/i, "")
      .replace(/(DR|CR)\s*$/i, "")
      .trim();
  }

  text = text.replace(CURRENCY_SYMBOLS, "").trim();

  // Trailing sign, as used by several European exports.
  if (text.endsWith("-")) {
    negative = !negative;
    text = text.slice(0, -1).trim();
  } else if (text.endsWith("+")) {
    text = text.slice(0, -1).trim();
  }

  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1).trim();
  } else if (text.startsWith("+")) {
    text = text.slice(1).trim();
  }

  text = text.replace(/\s| |'/g, "");

  if (text === "") throw new AmountParseError(input, "it has no digits");
  if (!/^[\d.,]+$/.test(text)) {
    throw new AmountParseError(input, "it contains characters that are not digits or separators");
  }

  return { body: text, negative };
}

/**
 * Work out whether a set of amount strings uses `.` or `,` as the decimal
 * separator, by looking for evidence that rules one out.
 *
 * Decisive evidence, in order:
 * 1. A value containing both separators — the rightmost is the decimal one.
 * 2. A separator followed by other than 2 digits at the end (`1.234.567`
 *    cannot be decimal dots; `1,234` with a 3-digit tail is grouping).
 * 3. A separator appearing more than once in one value — grouping.
 *
 * With no evidence either way it returns "dot", which is the majority
 * convention in the exports this is aimed at, and reports low confidence so
 * the caller can surface a warning.
 */
export function detectDecimalConvention(samples: readonly string[]): {
  convention: DecimalConvention;
  confident: boolean;
} {
  let dotEvidence = 0;
  let commaEvidence = 0;

  for (const sample of samples) {
    let body: string;
    try {
      body = strip(sample).body;
    } catch {
      continue;
    }

    const lastDot = body.lastIndexOf(".");
    const lastComma = body.lastIndexOf(",");

    if (lastDot !== -1 && lastComma !== -1) {
      // Both present: the rightmost separates the decimal.
      if (lastDot > lastComma) dotEvidence += 6;
      else commaEvidence += 6;
      continue;
    }

    const separator = lastDot !== -1 ? "." : lastComma !== -1 ? "," : null;
    if (separator === null) continue;

    const occurrences = body.split(separator).length - 1;
    const tail = body.slice(body.lastIndexOf(separator) + 1);

    if (occurrences > 1) {
      // Repeated separator must be grouping, so the *other* one is decimal.
      if (separator === ".") commaEvidence += 4;
      else dotEvidence += 4;
      continue;
    }

    if (tail.length === 3) {
      // Ambiguous on its own: "1,234" is usually grouping, but it is also how
      // a 3dp currency writes one point two three four. Weak evidence only.
      if (separator === ".") commaEvidence += 1;
      else dotEvidence += 1;
    } else if (tail.length !== 0) {
      // A tail of 1, 2, or 4+ digits cannot be a thousands group. Decisive,
      // and weighted so a single one of these outvotes several weak hints.
      if (separator === ".") dotEvidence += 4;
      else commaEvidence += 4;
    }
  }

  // A margin of one is a single weak hint, which is not enough to be sure.
  const margin = Math.abs(dotEvidence - commaEvidence);
  if (dotEvidence === commaEvidence) return { convention: "dot", confident: false };
  return {
    convention: dotEvidence > commaEvidence ? "dot" : "comma",
    confident: margin >= 2,
  };
}

/** Convert a decorated amount string into a plain decimal literal. */
export function normaliseAmount(input: string, convention: DecimalConvention = "dot"): string {
  const { body, negative } = strip(input);

  const decimalSeparator = convention === "dot" ? "." : ",";
  const groupSeparator = convention === "dot" ? "," : ".";

  const withoutGroups = body.split(groupSeparator).join("");
  const parts = withoutGroups.split(decimalSeparator);
  if (parts.length > 2) {
    throw new AmountParseError(input, `more than one '${decimalSeparator}' decimal separator`);
  }

  const whole = parts[0] === "" ? "0" : (parts[0] as string);
  const fraction = parts[1];

  if (!/^\d+$/.test(whole)) throw new AmountParseError(input, "malformed whole part");
  if (fraction !== undefined && !/^\d*$/.test(fraction)) {
    throw new AmountParseError(input, "malformed fractional part");
  }

  const magnitude = fraction === undefined || fraction === "" ? whole : `${whole}.${fraction}`;
  return negative ? `-${magnitude}` : magnitude;
}

export interface ParseAmountOptions {
  convention?: DecimalConvention;
  /** Allow more precision than the currency holds, rounding it away. */
  rounding?: RoundingMode;
}

/** Parse one amount into `Money`. */
export function parseAmount(
  input: string,
  currency: Currency | string,
  options: ParseAmountOptions = {},
): Money {
  const decimal = normaliseAmount(input, options.convention ?? "dot");
  return Money.parse(decimal, currency, options.rounding);
}

/**
 * Combine separate debit and credit columns into one signed amount.
 *
 * Statements that use two columns leave the irrelevant one blank or at zero.
 * Both populated is a contradiction and is reported rather than guessed at.
 */
export function combineDebitCredit(
  debit: string,
  credit: string,
  currency: Currency | string,
  options: ParseAmountOptions = {},
): Money {
  const hasDebit = debit.trim() !== "";
  const hasCredit = credit.trim() !== "";

  if (!hasDebit && !hasCredit) {
    throw new AmountParseError(`${debit}|${credit}`, "both debit and credit columns are empty");
  }

  const debitAmount = hasDebit ? parseAmount(debit, currency, options).abs() : null;
  const creditAmount = hasCredit ? parseAmount(credit, currency, options).abs() : null;

  const debitIsReal = debitAmount !== null && !debitAmount.isZero;
  const creditIsReal = creditAmount !== null && !creditAmount.isZero;

  if (debitIsReal && creditIsReal) {
    throw new AmountParseError(
      `${debit}|${credit}`,
      "both debit and credit columns carry a value",
    );
  }

  // Money out of the account is negative, money in is positive.
  if (debitIsReal) return (debitAmount as Money).negated();
  if (creditIsReal) return creditAmount as Money;

  // Both present but zero — a genuine zero-value line.
  return (debitAmount ?? (creditAmount as Money)).abs();
}

/** True when a string looks like an amount, used for column inference. */
export function looksLikeAmount(input: string): boolean {
  if (input.trim() === "") return false;
  try {
    strip(input);
    return true;
  } catch {
    return false;
  }
}
