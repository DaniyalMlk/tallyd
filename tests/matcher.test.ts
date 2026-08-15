import { describe, expect, it } from "vitest";
import { GBP, Money } from "../src/money/index.js";
import { date } from "../src/ledger/index.js";
import { statementLine, normaliseDescription } from "../src/statement/index.js";
import type { StatementLine } from "../src/statement/index.js";
import type { BookLine } from "../src/reconcile/bankView.js";
import { reconcile, describeMatch, significantReasons } from "../src/reconcile/matcher.js";

const gbp = (text: string) => Money.parse(text, GBP);

let bookCounter = 0;
function book(when: string, description: string, amount: string, reference?: string): BookLine {
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
    reference: reference ?? null,
    contraAccounts: Object.freeze(["5300"]),
    reverses: null,
    reversedBy: null,
    tags: Object.freeze([]),
  }) as BookLine;
}

let lineCounter = 0;
function bank(when: string, description: string, amount: string): StatementLine {
  lineCounter++;
  return statementLine({
    id: `BANK-${lineCounter}`,
    date: date(when),
    description,
    amount: gbp(amount),
    sourceRow: lineCounter,
  });
}

describe("reconcile — the simple cases", () => {
  it("pairs the obvious ones and leaves the rest alone", () => {
    const books = [
      book("2026-08-04", "August rent", "-1850.00"),
      book("2026-08-31", "Bank charges", "-18.00"),
    ];
    const statement = [
      bank("2026-08-04", "DD RENT, AUGUST 08", "-1850.00"),
      bank("2026-08-31", "BANK CHARGES", "-18.00"),
      bank("2026-08-18", "ATM CASH WITHDRAWAL 200000", "-60.00"),
    ];

    const result = reconcile(books, statement);
    expect(result.matched).toHaveLength(2);
    expect(result.unmatchedBook).toHaveLength(0);
    expect(result.unmatchedStatement.map((l) => l.description)).toEqual([
      "ATM CASH WITHDRAWAL 200000",
    ]);
    expect(result.stats.statementCoverage).toBeCloseTo(2 / 3, 6);
    expect(result.stats.bookCoverage).toBe(1);
  });

  it("handles empty input on either side", () => {
    expect(reconcile([], []).matched).toEqual([]);
    expect(reconcile([], [bank("2026-08-01", "X", "1.00")]).unmatchedStatement).toHaveLength(1);
    expect(reconcile([book("2026-08-01", "X", "1.00")], []).unmatchedBook).toHaveLength(1);
    expect(reconcile([], []).stats.statementCoverage).toBe(1);
  });

  it("never uses a line twice", () => {
    const books = [
      book("2026-08-10", "Widget", "-90.00"),
      book("2026-08-10", "Widget", "-90.00"),
    ];
    const statement = [bank("2026-08-10", "WIDGET", "-90.00")];
    const result = reconcile(books, statement);

    const usedBook = [...result.matched, ...result.suggested].flatMap((m) => m.book.map((b) => b.id));
    const usedStatement = [...result.matched, ...result.suggested].flatMap((m) =>
      m.statement.map((l) => l.id),
    );
    expect(new Set(usedBook).size).toBe(usedBook.length);
    expect(new Set(usedStatement).size).toBe(usedStatement.length);
    expect(usedStatement).toHaveLength(1);
    expect(result.unmatchedBook).toHaveLength(1);
  });

  it("accounts for every line exactly once across all four buckets", () => {
    const books = [
      book("2026-08-01", "Share capital", "25000.00"),
      book("2026-08-04", "August rent", "-1850.00"),
      book("2026-08-14", "Client dinner", "-142.50"),
      book("2026-08-15", "Client dinner — recoded", "-142.50"),
    ];
    const statement = [
      bank("2026-08-01", "BGC SHARE CAPITAL", "25000.00"),
      bank("2026-08-04", "DD RENT, AUGUST 08", "-1850.00"),
      bank("2026-08-14", "CARD PAYMENT TO BISTRO ON 14-AUG", "-142.50"),
      bank("2026-08-15", "CARD PAYMENT TO BISTRO ON 14-AUG", "-142.50"),
      bank("2026-08-29", "HMRC PAYE NI", "-2180.00"),
    ];

    const result = reconcile(books, statement);
    const bookIds = [
      ...result.matched.flatMap((m) => m.book.map((b) => b.id)),
      ...result.suggested.flatMap((m) => m.book.map((b) => b.id)),
      ...result.unmatchedBook.map((b) => b.id),
    ];
    const statementIds = [
      ...result.matched.flatMap((m) => m.statement.map((l) => l.id)),
      ...result.suggested.flatMap((m) => m.statement.map((l) => l.id)),
      ...result.unmatchedStatement.map((l) => l.id),
    ];
    expect(bookIds.sort()).toEqual(books.map((b) => b.id).sort());
    expect(statementIds.sort()).toEqual(statement.map((l) => l.id).sort());
  });
});

describe("reconcile — conflict resolution", () => {
  it("chooses the globally best pairing, not the first good one", () => {
    // Both statement lines are exactly £500 on the same day. Greedy would take
    // whichever pair scored highest and strand the other; the assignment pass
    // has to hand each ledger entry the line that names it.
    const books = [
      book("2026-08-10", "Kestrel Print invoice", "-500.00"),
      book("2026-08-10", "Mirrell Legal invoice", "-500.00"),
    ];
    const statement = [
      bank("2026-08-10", "MIRRELL LEGAL", "-500.00"),
      bank("2026-08-10", "KESTREL PRINT", "-500.00"),
    ];

    const result = reconcile(books, statement);
    const pairs = [...result.matched, ...result.suggested].map(
      (m) => [m.book[0]?.description, m.statement[0]?.description] as const,
    );
    expect(pairs).toContainEqual(["Kestrel Print invoice", "KESTREL PRINT"]);
    expect(pairs).toContainEqual(["Mirrell Legal invoice", "MIRRELL LEGAL"]);
  });

  it("puts an ambiguous pair in the review queue rather than the matched set", () => {
    const books = [book("2026-08-14", "Client dinner", "-142.50")];
    const statement = [bank("2026-08-14", "CARD PAYMENT TO BISTRO ON 14-AUG", "-142.50")];

    const result = reconcile(books, statement);
    expect(result.matched).toHaveLength(0);
    expect(result.suggested).toHaveLength(1);
    expect(result.suggested[0]?.scored.confidence).toBe("medium");
  });

  it("orders the review queue best first", () => {
    const books = [
      book("2026-08-10", "Something vague", "-90.00"),
      book("2026-08-11", "August rent payment", "-1850.00"),
    ];
    const statement = [
      bank("2026-08-10", "ZZZZ QQQQ", "-90.00"),
      bank("2026-08-12", "DD RENT, AUGUST 08", "-1850.00"),
    ];
    const result = reconcile(books, statement);
    const scores = result.suggested.map((m) => m.scored.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("respects a tightened auto-accept threshold", () => {
    const books = [book("2026-08-04", "August rent", "-1850.00")];
    const statement = [bank("2026-08-04", "DD RENT, AUGUST 08", "-1850.00")];

    expect(reconcile(books, statement).matched).toHaveLength(1);
    expect(reconcile(books, statement, { autoAcceptScore: 0.99 }).matched).toHaveLength(0);
    expect(reconcile(books, statement, { autoAcceptScore: 0.99 }).suggested).toHaveLength(1);
  });

  it("drops a pair below the suggestion floor entirely", () => {
    const books = [book("2026-08-10", "Something vague", "-90.00")];
    const statement = [bank("2026-08-10", "ZZZZ QQQQ", "-90.00")];

    const loose = reconcile(books, statement);
    expect(loose.suggested.length + loose.matched.length).toBe(1);

    const strict = reconcile(books, statement, { suggestScore: 0.9 });
    expect(strict.suggested).toHaveLength(0);
    expect(strict.unmatchedBook).toHaveLength(1);
    expect(strict.unmatchedStatement).toHaveLength(1);
  });
});

describe("reconcile — group matching", () => {
  const supplierBooks = () => [
    book("2026-09-10", "Kestrel Print — KP-4417", "-412.80", "KP-4417"),
    book("2026-09-10", "Halden Office Supplies — HOS-9002", "-168.44", "HOS-9002"),
    book("2026-09-10", "Mirrell Legal — ML-233", "-1250.00", "ML-233"),
    book("2026-09-10", "Corbin Facilities — CF-8810", "-306.76", "CF-8810"),
  ];

  it("finds a batch payment as one statement line against four ledger entries", () => {
    const books = supplierBooks();
    const statement = [bank("2026-09-10", "BACS SUPPLIER RUN 100926", "-2138.00")];

    const result = reconcile(books, statement);
    const group = [...result.matched, ...result.suggested].find((m) => m.kind === "one-to-many");
    expect(group).toBeDefined();
    expect(group?.book).toHaveLength(4);
    expect(group?.statement).toHaveLength(1);
    expect(group?.scored.amountGap).toBe(0n);
  });

  it("finds the mirror case: one ledger entry against several statement lines", () => {
    const books = [book("2026-09-10", "Weekly card takings", "900.00")];
    const statement = [
      bank("2026-09-10", "CARD TAKINGS", "300.00"),
      bank("2026-09-11", "CARD TAKINGS", "250.00"),
      bank("2026-09-12", "CARD TAKINGS", "350.00"),
    ];

    const result = reconcile(books, statement);
    const group = [...result.matched, ...result.suggested].find((m) => m.kind === "many-to-one");
    expect(group).toBeDefined();
    expect(group?.statement).toHaveLength(3);
    expect(group?.book).toHaveLength(1);
  });

  it("prefers a plain pair over a group that only adds up by cancellation", () => {
    // The reversal pair nets to zero, so invoice + dinner + reversal also sums
    // to 7200. That is arithmetic, not evidence.
    const books = [
      book("2026-08-12", "Invoice 1001 settled", "7200.00", "INV-1001"),
      book("2026-08-14", "Client dinner", "-142.50"),
      book("2026-08-15", "Reverse JE-008", "142.50"),
    ];
    const statement = [bank("2026-08-12", "FPI ACME LTD INV1001", "7200.00")];

    const result = reconcile(books, statement);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]?.kind).toBe("one-to-one");
    expect(result.matched[0]?.book).toHaveLength(1);
    expect(result.unmatchedBook).toHaveLength(2);
  });

  it("can be turned off", () => {
    const books = supplierBooks();
    const statement = [bank("2026-09-10", "BACS SUPPLIER RUN 100926", "-2138.00")];

    const result = reconcile(books, statement, { groupMatching: false });
    expect(result.matched).toHaveLength(0);
    expect(result.suggested).toHaveLength(0);
    expect(result.unmatchedBook).toHaveLength(4);
    expect(result.unmatchedStatement).toHaveLength(1);
  });

  it("respects the maximum group size", () => {
    const books = supplierBooks();
    const statement = [bank("2026-09-10", "BACS SUPPLIER RUN 100926", "-2138.00")];

    const result = reconcile(books, statement, { maxGroupSize: 3 });
    expect([...result.matched, ...result.suggested]).toHaveLength(0);
  });

  it("respects the group date window", () => {
    const books = [
      book("2026-09-10", "Kestrel Print", "-412.80"),
      book("2026-09-12", "Halden Office", "-168.44"),
    ];
    const statement = [bank("2026-09-12", "BACS RUN", "-581.24")];

    const wide = reconcile(books, statement, { groupWindowDays: 20 });
    expect([...wide.matched, ...wide.suggested]).toHaveLength(1);

    const narrow = reconcile(books, statement, { groupWindowDays: 1 });
    expect([...narrow.matched, ...narrow.suggested]).toHaveLength(0);
    expect(narrow.unmatchedBook).toHaveLength(2);
  });

  it("reports that the group search finished", () => {
    const result = reconcile(supplierBooks(), [
      bank("2026-09-10", "BACS SUPPLIER RUN 100926", "-2138.00"),
    ]);
    expect(result.stats.groupSearchExhaustive).toBe(true);
  });
});

describe("reconcile — determinism and reporting", () => {
  const books = [
    book("2026-08-01", "Share capital", "25000.00"),
    book("2026-08-04", "August rent", "-1850.00"),
    book("2026-08-12", "Invoice 1001 settled", "7200.00"),
    book("2026-08-28", "August payroll", "-7220.00"),
  ];
  const statement = [
    bank("2026-08-01", "BGC SHARE CAPITAL", "25000.00"),
    bank("2026-08-04", "DD RENT, AUGUST 08", "-1850.00"),
    bank("2026-08-12", "FPI ACME LTD INV1001", "7200.00"),
    bank("2026-08-28", "PAYROLL AUGUST", "-7220.00"),
    bank("2026-08-29", "HMRC PAYE NI", "-2180.00"),
  ];

  it("produces the same answer every time", () => {
    const once = reconcile(books, statement);
    const twice = reconcile(books, statement);
    expect(once.matched.map(describeMatch)).toEqual(twice.matched.map(describeMatch));
    expect(once.suggested.map(describeMatch)).toEqual(twice.suggested.map(describeMatch));
  });

  it("returns matches in date order", () => {
    const dates = reconcile(books, statement).matched.map((m) => m.statement[0]?.date ?? "");
    expect(dates).toEqual([...dates].sort());
  });

  it("describes a match in one line", () => {
    const result = reconcile(books, statement);
    const rent = result.matched.find((m) => m.book[0]?.description === "August rent");
    expect(describeMatch(rent as never)).toBe(
      "2026-08-04 -1850.00 August rent  <->  2026-08-04 -1850.00 DD RENT, AUGUST 08",
    );
  });

  it("lists only the reasons that carried weight, best first", () => {
    const result = reconcile(books, statement);
    const rent = result.matched.find((m) => m.book[0]?.description === "August rent");
    const reasons = significantReasons(rent as never);
    expect(reasons.some((r) => r.startsWith("amount:"))).toBe(true);
    expect(reasons.some((r) => r.startsWith("date:"))).toBe(true);
    expect(reasons.every((r) => !r.includes("neither side carries"))).toBe(true);
  });

  it("counts what it did", () => {
    const result = reconcile(books, statement);
    expect(result.stats.bookLines).toBe(4);
    expect(result.stats.statementLines).toBe(5);
    expect(result.stats.matchedPairs).toBe(result.matched.filter((m) => m.kind === "one-to-one").length);
    expect(result.stats.suggestions).toBe(result.suggested.length);
    expect(result.stats.statementCoverage).toBeGreaterThan(0.5);
  });
});
