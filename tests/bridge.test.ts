import { describe, expect, it } from "vitest";
import { GBP, USD, Money } from "../src/money/index.js";
import { date } from "../src/ledger/index.js";
import { statementLine, normaliseDescription } from "../src/statement/index.js";
import type { StatementLine } from "../src/statement/index.js";
import type { BookLine } from "../src/reconcile/bankView.js";
import { reconcile } from "../src/reconcile/matcher.js";
import {
  reconciliationBridge,
  renderReconciliationBridge,
  statementClosingBalance,
} from "../src/reconcile/bridge.js";

const gbp = (text: string) => Money.parse(text, GBP);

let bookCounter = 0;
function book(when: string, description: string, amount: string): BookLine {
  bookCounter++;
  return Object.freeze({
    id: `JE-${bookCounter}#0`,
    entryId: `JE-${bookCounter}`,
    postingIndex: 0,
    date: date(when),
    account: "1110",
    amount: gbp(amount),
    description,
    normalisedDescription: normaliseDescription(description),
    reference: null,
    contraAccounts: Object.freeze(["5300"]),
    reverses: null,
    reversedBy: null,
    tags: Object.freeze([]),
  }) as BookLine;
}

let lineCounter = 0;
function bank(
  when: string,
  description: string,
  amount: string,
  balance?: string,
): StatementLine {
  lineCounter++;
  return statementLine({
    id: `BANK-${lineCounter}`,
    date: date(when),
    description,
    amount: gbp(amount),
    sourceRow: lineCounter,
    ...(balance !== undefined ? { balance: gbp(balance) } : {}),
  });
}

function totalOf(lines: readonly { amount: Money }[]): bigint {
  return lines.reduce((sum, line) => sum + line.amount.minorUnits, 0n);
}

describe("statementClosingBalance", () => {
  it("trusts the bank's own balance column when there is one", () => {
    const lines = [
      bank("2026-08-01", "OPENING", "100.00", "1100.00"),
      bank("2026-08-02", "PAYMENT", "-50.00", "1050.00"),
    ];
    expect(statementClosingBalance(lines, gbp("1000.00")).toDecimalString()).toBe("1050.00");
  });

  it("falls back to opening plus movements when the bank supplied none", () => {
    const lines = [bank("2026-08-01", "IN", "100.00"), bank("2026-08-02", "OUT", "-30.00")];
    expect(statementClosingBalance(lines, gbp("1000.00")).toDecimalString()).toBe("1070.00");
  });

  it("returns the opening balance for an empty statement", () => {
    expect(statementClosingBalance([], gbp("42.00")).toDecimalString()).toBe("42.00");
  });
});

describe("reconciliationBridge", () => {
  const books = [
    book("2026-08-04", "August rent", "-1850.00"),
    book("2026-08-31", "Bank charges", "-18.00"),
    book("2026-08-30", "Cheque to supplier", "-260.00"),
  ];
  const statement = [
    bank("2026-08-04", "DD RENT, AUGUST 08", "-1850.00"),
    bank("2026-08-29", "HMRC PAYE NI", "-2180.00"),
    bank("2026-08-31", "BANK CHARGES", "-18.00"),
    bank("2026-08-31", "INTEREST PAID", "3.12"),
  ];

  const result = reconcile(books, statement);
  const bookBalance = Money.ofMinor(10_000_00n + totalOf(books), GBP);
  const bankBalance = Money.ofMinor(10_000_00n + totalOf(statement), GBP);
  const bridge = reconciliationBridge(result, {
    bankClosingBalance: bankBalance,
    bookClosingBalance: bookBalance,
  });

  it("balances", () => {
    expect(bridge.reconciled).toBe(true);
    expect(bridge.difference.isZero).toBe(true);
    expect(bridge.adjustedBankBalance.equals(bridge.adjustedBookBalance)).toBe(true);
  });

  it("splits the leftovers into the four schedules an accountant expects", () => {
    expect(bridge.unpresentedPayments.map((l) => l.description)).toEqual(["Cheque to supplier"]);
    expect(bridge.depositsInTransit).toEqual([]);
    expect(bridge.bankDebitsNotBooked.map((l) => l.description)).toEqual(["HMRC PAYE NI"]);
    expect(bridge.bankCreditsNotBooked.map((l) => l.description)).toEqual(["INTEREST PAID"]);
  });

  it("reports what the matched lines came to on each side", () => {
    expect(bridge.matchedBookTotal.equals(bridge.matchedStatementTotal)).toBe(true);
    expect(bridge.matchedBookTotal.toDecimalString()).toBe("-1868.00");
  });

  it("treats an unconfirmed suggestion as outstanding, not as evidence", () => {
    const ambiguous = [book("2026-08-14", "Client dinner", "-142.50")];
    const seen = [bank("2026-08-14", "CARD PAYMENT TO BISTRO ON 14-AUG", "-142.50")];
    const suggested = reconcile(ambiguous, seen);
    expect(suggested.suggested).toHaveLength(1);

    const withSuggestion = reconciliationBridge(suggested, {
      bankClosingBalance: gbp("-142.50"),
      bookClosingBalance: gbp("-142.50"),
    });
    expect(withSuggestion.unpresentedPayments).toHaveLength(1);
    expect(withSuggestion.bankDebitsNotBooked).toHaveLength(1);
    expect(withSuggestion.reconciled).toBe(true);
    expect(withSuggestion.matchedBookTotal.isZero).toBe(true);
  });

  it("refuses to bridge two different currencies", () => {
    expect(() =>
      reconciliationBridge(result, {
        bankClosingBalance: Money.parse("10.00", USD),
        bookClosingBalance: gbp("10.00"),
      }),
    ).toThrow(/USD/);
  });

  it("renders a schedule a human can read", () => {
    const text = renderReconciliationBridge(bridge);
    expect(text).toContain("Balance per bank statement");
    expect(text).toContain("Less: payments not yet on the statement");
    expect(text).toContain("Add: bank credits not yet booked");
    expect(text).toContain("Reconciled");
    expect(text).not.toContain("UNRECONCILED");
  });

  it("says so loudly when the balances do not bridge", () => {
    const broken = reconciliationBridge(result, {
      bankClosingBalance: bankBalance.plus(gbp("1.00")),
      bookClosingBalance: bookBalance,
    });
    expect(broken.reconciled).toBe(false);
    expect(broken.difference.toDecimalString()).toBe("1.00");
    expect(renderReconciliationBridge(broken)).toContain("UNRECONCILED DIFFERENCE");
  });
});

describe("the bridge balances whatever the matcher decides", () => {
  it("holds across 400 random books-and-statement pairs", () => {
    let seed = 8_14_2026;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const randInt = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

    const words = ["RENT", "PAYROLL", "ACME", "TOOLCHAIN", "BISTRO", "HMRC", "INTEREST", "ATM"];
    const opening = 500_000n;

    for (let trial = 0; trial < 400; trial++) {
      const bookCount = randInt(0, 7);
      const statementCount = randInt(0, 7);

      const books: BookLine[] = [];
      for (let i = 0; i < bookCount; i++) {
        const amount = randInt(-40_000, 40_000);
        if (amount === 0) continue;
        books.push(
          book(
            `2026-08-${String(randInt(1, 28)).padStart(2, "0")}`,
            `${words[randInt(0, words.length - 1)]} ${randInt(1, 9)}`,
            (amount / 100).toFixed(2),
          ),
        );
      }

      const statement: StatementLine[] = [];
      for (let i = 0; i < statementCount; i++) {
        // Half the time, echo a book line so there is something to match.
        const source = books[randInt(0, Math.max(0, books.length - 1))];
        const echo = rnd() < 0.5 && source !== undefined;
        const amount = echo
          ? Number(source.amount.minorUnits)
          : randInt(-40_000, 40_000);
        if (amount === 0) continue;
        statement.push(
          bank(
            echo ? source.date : `2026-08-${String(randInt(1, 28)).padStart(2, "0")}`,
            echo ? source.description.toUpperCase() : `${words[randInt(0, words.length - 1)]}`,
            (amount / 100).toFixed(2),
          ),
        );
      }

      const result = reconcile(books, statement);
      const bridge = reconciliationBridge(result, {
        bankClosingBalance: Money.ofMinor(opening + totalOf(statement), GBP),
        bookClosingBalance: Money.ofMinor(opening + totalOf(books), GBP),
      });

      expect(bridge.difference.minorUnits).toBe(0n);
      expect(bridge.reconciled).toBe(true);
      // And the matched sides really did agree, which is what makes it balance.
      expect(bridge.matchedBookTotal.minorUnits).toBe(bridge.matchedStatementTotal.minorUnits);
    }
  });
});
