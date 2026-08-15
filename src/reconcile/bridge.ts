/**
 * The bank reconciliation statement.
 *
 * This is the piece that turns a fuzzy-matching exercise into an accounting
 * one. Matching produces two piles of leftovers; the bridge explains them, by
 * walking from the balance the bank says we have to the balance our own books
 * say we have, one reconciling item at a time:
 *
 *     balance per bank statement
 *       + our receipts the bank has not seen yet   (deposits in transit)
 *       - our payments the bank has not seen yet   (unpresented payments)
 *       = adjusted balance
 *
 *     balance per our books
 *       + the bank's credits we have not booked    (interest, refunds)
 *       - the bank's debits we have not booked     (charges, direct debits)
 *       = adjusted balance
 *
 * The two adjusted balances are equal, or the reconciliation is wrong. That is
 * not a convention — it follows from the fact that every match pairs equal
 * amounts, so the whole of the difference between the two closing balances has
 * to live in the unmatched items. Which makes it the strongest test available:
 * a matcher that pairs the wrong things still balances, but a matcher that
 * loses or double-counts a line cannot.
 */

import { Money } from "../money/money.js";
import type { Currency } from "../money/currency.js";
import type { StatementLine } from "../statement/line.js";
import type { BookLine } from "./bankView.js";
import type { ReconciliationResult } from "./matcher.js";

export interface BridgeInput {
  /** Closing balance the bank reports. */
  readonly bankClosingBalance: Money;
  /** Closing balance of the bank account in our ledger. */
  readonly bookClosingBalance: Money;
}

export interface ReconciliationBridge {
  readonly currency: Currency;
  readonly bankClosingBalance: Money;
  readonly bookClosingBalance: Money;

  /** Money in, in our books, that the bank has not shown yet. */
  readonly depositsInTransit: readonly BookLine[];
  /** Money out, in our books, that the bank has not shown yet. */
  readonly unpresentedPayments: readonly BookLine[];
  /** Money in, on the statement, that we have not booked. */
  readonly bankCreditsNotBooked: readonly StatementLine[];
  /** Money out, on the statement, that we have not booked. */
  readonly bankDebitsNotBooked: readonly StatementLine[];

  readonly adjustedBankBalance: Money;
  readonly adjustedBookBalance: Money;
  /** `adjustedBank - adjustedBook`. Zero when the reconciliation holds. */
  readonly difference: Money;
  readonly reconciled: boolean;

  /** Total of the ledger side of every confident match. */
  readonly matchedBookTotal: Money;
  /** Total of the statement side of every confident match. */
  readonly matchedStatementTotal: Money;
}

function totalOf(minorUnits: bigint, currency: Currency): Money {
  return Money.ofMinor(minorUnits, currency);
}

/**
 * Build the bridge from a reconciliation result and the two closing balances.
 *
 * Suggested matches count as unmatched here, deliberately: until a human has
 * confirmed one it is not evidence, and a reconciliation that quietly leans on
 * unreviewed guesses is worse than one that shows the gap.
 */
export function reconciliationBridge(
  result: ReconciliationResult,
  input: BridgeInput,
): ReconciliationBridge {
  const currency = input.bankClosingBalance.currency;
  if (!input.bankClosingBalance.sameCurrency(input.bookClosingBalance)) {
    throw new Error(
      `Cannot bridge ${input.bankClosingBalance.currency.code} against ${input.bookClosingBalance.currency.code}`,
    );
  }

  const outstandingBook = [
    ...result.unmatchedBook,
    ...result.suggested.flatMap((match) => match.book),
  ].sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? -1 : 1));

  const outstandingStatement = [
    ...result.unmatchedStatement,
    ...result.suggested.flatMap((match) => match.statement),
  ].sort((a, b) =>
    a.date === b.date ? a.sourceRow - b.sourceRow : a.date < b.date ? -1 : 1,
  );

  const depositsInTransit = outstandingBook.filter((line) => line.amount.isPositive);
  const unpresentedPayments = outstandingBook.filter((line) => !line.amount.isPositive);
  const bankCreditsNotBooked = outstandingStatement.filter((line) => line.amount.isPositive);
  const bankDebitsNotBooked = outstandingStatement.filter((line) => !line.amount.isPositive);

  const outstandingBookTotal = outstandingBook.reduce(
    (sum, line) => sum + line.amount.minorUnits,
    0n,
  );
  const outstandingStatementTotal = outstandingStatement.reduce(
    (sum, line) => sum + line.amount.minorUnits,
    0n,
  );

  const adjustedBankBalance = totalOf(
    input.bankClosingBalance.minorUnits + outstandingBookTotal,
    currency,
  );
  const adjustedBookBalance = totalOf(
    input.bookClosingBalance.minorUnits + outstandingStatementTotal,
    currency,
  );
  const difference = adjustedBankBalance.minus(adjustedBookBalance);

  const matchedBookTotal = result.matched.reduce(
    (sum, match) => sum + match.book.reduce((inner, book) => inner + book.amount.minorUnits, 0n),
    0n,
  );
  const matchedStatementTotal = result.matched.reduce(
    (sum, match) => sum + match.statement.reduce((inner, line) => inner + line.amount.minorUnits, 0n),
    0n,
  );

  return Object.freeze({
    currency,
    bankClosingBalance: input.bankClosingBalance,
    bookClosingBalance: input.bookClosingBalance,
    depositsInTransit: Object.freeze(depositsInTransit),
    unpresentedPayments: Object.freeze(unpresentedPayments),
    bankCreditsNotBooked: Object.freeze(bankCreditsNotBooked),
    bankDebitsNotBooked: Object.freeze(bankDebitsNotBooked),
    adjustedBankBalance,
    adjustedBookBalance,
    difference,
    reconciled: difference.isZero,
    matchedBookTotal: totalOf(matchedBookTotal, currency),
    matchedStatementTotal: totalOf(matchedStatementTotal, currency),
  });
}

/**
 * Closing balance implied by a run of statement lines.
 *
 * Uses the balance column when the bank supplied one on the last line, since
 * that is the bank's own assertion and outranks anything we derive; falls back
 * to the opening balance plus the movements.
 */
export function statementClosingBalance(
  lines: readonly StatementLine[],
  openingBalance: Money,
): Money {
  const last = lines[lines.length - 1];
  if (last !== undefined && last.balance !== null) return last.balance;
  return lines.reduce((total, line) => total.plus(line.amount), openingBalance);
}

const pad = (text: string, width: number): string =>
  text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);

const money = (value: Money): string => value.toDecimalString().padStart(12);

/** The bridge as a plain-text schedule, the way an accountant would lay it out. */
export function renderReconciliationBridge(bridge: ReconciliationBridge): string {
  const out: string[] = [];

  out.push(`Bank reconciliation (${bridge.currency.code})`);
  out.push("=".repeat(64));
  out.push(`${pad("Balance per bank statement", 46)}${money(bridge.bankClosingBalance)}`);

  if (bridge.depositsInTransit.length > 0) {
    out.push("  Add: receipts not yet on the statement");
    for (const line of bridge.depositsInTransit) {
      out.push(`    ${pad(`${line.date}  ${line.description}`, 44)}${money(line.amount)}`);
    }
  }
  if (bridge.unpresentedPayments.length > 0) {
    out.push("  Less: payments not yet on the statement");
    for (const line of bridge.unpresentedPayments) {
      out.push(`    ${pad(`${line.date}  ${line.description}`, 44)}${money(line.amount)}`);
    }
  }
  out.push(`${pad("Adjusted bank balance", 46)}${money(bridge.adjustedBankBalance)}`);
  out.push("");

  out.push(`${pad("Balance per the ledger", 46)}${money(bridge.bookClosingBalance)}`);
  if (bridge.bankCreditsNotBooked.length > 0) {
    out.push("  Add: bank credits not yet booked");
    for (const line of bridge.bankCreditsNotBooked) {
      out.push(`    ${pad(`${line.date}  ${line.description}`, 44)}${money(line.amount)}`);
    }
  }
  if (bridge.bankDebitsNotBooked.length > 0) {
    out.push("  Less: bank debits not yet booked");
    for (const line of bridge.bankDebitsNotBooked) {
      out.push(`    ${pad(`${line.date}  ${line.description}`, 44)}${money(line.amount)}`);
    }
  }
  out.push(`${pad("Adjusted ledger balance", 46)}${money(bridge.adjustedBookBalance)}`);
  out.push("-".repeat(64));
  out.push(
    `${pad(bridge.reconciled ? "Reconciled" : "UNRECONCILED DIFFERENCE", 46)}${money(bridge.difference)}`,
  );

  return out.join("\n");
}
