/**
 * Runs the matcher over both worked examples and prints what it decided. Run
 * with:
 *
 *     npm run demo:reconcile
 */

import { GBP } from "../money/currency.js";
import { Money } from "../money/money.js";
import { importCsv } from "../statement/import.js";
import type { StatementLine } from "../statement/line.js";
import { bankView } from "../reconcile/bankView.js";
import type { BookLine } from "../reconcile/bankView.js";
import {
  reconcile,
  significantReasons,
  type Match,
  type ReconciliationResult,
} from "../reconcile/matcher.js";
import {
  reconciliationBridge,
  renderReconciliationBridge,
  statementClosingBalance,
} from "../reconcile/bridge.js";
import { demoLedger } from "./month.js";
import { DEMO_BANK_CSV } from "./statement.js";
import { SUPPLIER_RUN_CSV, supplierRunLedger } from "./supplierRun.js";

const BANK_ACCOUNT = "1110";

export interface ReconciledScenario {
  readonly name: string;
  readonly books: readonly BookLine[];
  readonly statement: readonly StatementLine[];
  readonly result: ReconciliationResult;
}

function scenario(name: string, ledgerCsv: string, ledger = demoLedger()): ReconciledScenario {
  const imported = importCsv(ledgerCsv, { currency: GBP, idPrefix: "BANK" });
  const statement = [...imported.lines, ...imported.duplicates.map((flag) => flag.line)].sort(
    (a, b) => a.sourceRow - b.sourceRow,
  );
  const books = bankView(ledger, BANK_ACCOUNT);
  return Object.freeze({
    name,
    books,
    statement,
    result: reconcile(books, statement),
  });
}

/** The worked month against the bank's record of it. */
export function monthScenario(): ReconciledScenario {
  return scenario("The worked month", DEMO_BANK_CSV, demoLedger());
}

/** The BACS run and the lump-sum receipt: group matching in both directions. */
export function supplierRunScenario(): ReconciledScenario {
  return scenario("Batch payments and a lump-sum receipt", SUPPLIER_RUN_CSV, supplierRunLedger());
}

const KIND_LABEL: Record<Match["kind"], string> = {
  "one-to-one": "1:1",
  "one-to-many": "1:N",
  "many-to-one": "N:1",
};

function renderMatch(match: Match, indent: string): string[] {
  const out: string[] = [];
  const total = match.statement.reduce(
    (sum, line) => sum.plus(line.amount),
    Money.zero(match.statement[0]?.amount.currency ?? GBP),
  );

  out.push(
    `${indent}${KIND_LABEL[match.kind]}  ${match.scored.confidence.padEnd(7)}` +
      `${match.scored.score.toFixed(3)}  ${total.toDecimalString().padStart(11)}`,
  );
  for (const line of match.statement) {
    out.push(`${indent}     bank    ${line.date}  ${line.description}`);
  }
  for (const book of match.book) {
    out.push(`${indent}     ledger  ${book.date}  ${book.description}`);
  }
  for (const reason of significantReasons(match)) {
    out.push(`${indent}       · ${reason}`);
  }
  return out;
}

export function reconcileReport(): string {
  const out: string[] = [];

  for (const view of [monthScenario(), supplierRunScenario()]) {
    const { result } = view;
    out.push(view.name);
    out.push("=".repeat(64));
    out.push(
      `  ${result.stats.bookLines} ledger movements against ${result.stats.statementLines} statement lines`,
    );
    out.push(
      `  ${result.matched.length} matched (${result.stats.matchedPairs} pairs, ` +
        `${result.stats.matchedGroups} groups), ${result.suggested.length} to review, ` +
        `${result.unmatchedBook.length} + ${result.unmatchedStatement.length} unmatched`,
    );
    out.push(
      `  coverage: ${(result.stats.statementCoverage * 100).toFixed(0)}% of the statement, ` +
        `${(result.stats.bookCoverage * 100).toFixed(0)}% of the ledger`,
    );
    out.push("");

    out.push("Matched");
    for (const match of result.matched) out.push(...renderMatch(match, "  "));
    out.push("");

    if (result.suggested.length > 0) {
      out.push("Review queue");
      for (const match of result.suggested) out.push(...renderMatch(match, "  "));
      out.push("");
    }

    if (result.unmatchedStatement.length > 0) {
      out.push("On the statement, not in the books");
      for (const line of result.unmatchedStatement) {
        out.push(
          `  ${line.date}  ${line.amount.toDecimalString().padStart(10)}  ${line.description}`,
        );
      }
      out.push("");
    }

    if (result.unmatchedBook.length > 0) {
      out.push("In the books, not on the statement");
      for (const book of result.unmatchedBook) {
        out.push(
          `  ${book.date}  ${book.amount.toDecimalString().padStart(10)}  ${book.description}`,
        );
      }
      out.push("");
    }

    const ledgerBalance = view.books.reduce(
      (total, book) => total.plus(book.amount),
      Money.zero(GBP),
    );
    const bridge = reconciliationBridge(result, {
      bankClosingBalance: statementClosingBalance(view.statement, Money.zero(GBP)),
      bookClosingBalance: ledgerBalance,
    });
    out.push(renderReconciliationBridge(bridge));
    out.push("");
    out.push("");
  }

  return out.join("\n");
}
