import { describe, expect, it } from "vitest";
import { reconcile } from "../src/reconcile/matcher.js";
import { bankView } from "../src/reconcile/bankView.js";
import { measureAccuracy } from "../src/reconcile/accuracy.js";
import { generateBooks } from "../src/demo/generator.js";
import { Money } from "../src/money/money.js";
import { GBP } from "../src/money/currency.js";
import { date } from "../src/ledger/date.js";
import { statementLine, type StatementLine } from "../src/statement/line.js";
import type { BookLine } from "../src/reconcile/bankView.js";

const book = (id: string, day: string, minor: number, description = id): BookLine =>
  ({
    id,
    entryId: id,
    postingIndex: 0,
    date: date(day),
    account: "1110",
    amount: Money.ofMinor(BigInt(minor), GBP),
    description,
    normalisedDescription: description.toUpperCase(),
    reference: null,
    contraAccounts: [],
    reverses: null,
    reversedBy: null,
    tags: [],
  }) as BookLine;

const line = (id: string, day: string, minor: number, description = id): StatementLine =>
  statementLine({
    id,
    date: date(day),
    description,
    amount: Money.ofMinor(BigInt(minor), GBP),
    sourceRow: 0,
  });

describe("group matching does not mix directions", () => {
  it("will not explain a receipt as an invoice plus two entries that cancel", () => {
    // 7200 in, and in the books: 7200 out, 10000 in, 4400 out. The subset
    // {10000, -4400, ...} can be made to reach 7200 only by mixing money in
    // with money out, which is not a batch — it is a coincidence.
    const books = [
      book("B1", "2026-05-10", -7200),
      book("B2", "2026-05-11", 10000),
      book("B3", "2026-05-12", -2800),
    ];
    const statement = [line("S1", "2026-05-11", 7200)];

    const result = reconcile(books, statement);
    for (const match of [...result.matched, ...result.suggested]) {
      const signs = new Set(match.book.map((entry) => entry.amount.sign));
      signs.delete(0);
      expect(signs.size).toBeLessThanOrEqual(1);
    }
  });

  it("still finds a genuine same-direction batch", () => {
    const books = [
      book("B1", "2026-05-10", -1200, "Ashgrove Supplies"),
      book("B2", "2026-05-11", -800, "Kettleby Print"),
      book("B3", "2026-05-12", -2000, "Meridian Hosting"),
    ];
    const statement = [line("S1", "2026-05-13", -4000, "BACS SUPPLIER RUN 442901")];

    const result = reconcile(books, statement);
    const all = [...result.matched, ...result.suggested];
    const batch = all.find((match) => match.book.length === 3);
    expect(batch).toBeDefined();
    expect(batch?.kind).toBe("one-to-many");
  });

  it("still finds a many-to-one where the bank split one payment", () => {
    const books = [book("B1", "2026-05-10", -5000, "Wentworth Legal")];
    const statement = [
      line("S1", "2026-05-10", -3000, "FPO WENTWORTH LEGAL"),
      line("S2", "2026-05-11", -2000, "FPO WENTWORTH LEGAL"),
    ];

    const result = reconcile(books, statement);
    const all = [...result.matched, ...result.suggested];
    const split = all.find((match) => match.statement.length === 2);
    expect(split).toBeDefined();
    expect(split?.kind).toBe("many-to-one");
  });

  it("leaves a zero-value movement free to join either side", () => {
    const books = [book("B1", "2026-05-10", -1000), book("B2", "2026-05-10", 0)];
    const statement = [line("S1", "2026-05-10", -1000)];
    expect(() => reconcile(books, statement)).not.toThrow();
  });
});

describe("the matcher only scores pairs worth scoring", () => {
  it("reports far fewer scored pairs than the cross product", () => {
    const generated = generateBooks({ seed: 77, months: 6, invoicesPerMonth: 12 });
    const books = bankView(generated.ledger, generated.bankAccount);
    const result = reconcile(books, generated.statement);

    const cross = books.length * generated.statement.length;
    expect(cross).toBeGreaterThan(10_000);
    expect(result.stats.pairsScored).toBeLessThan(cross * 0.05);
    // Every real pair still has to be among them, or recall would have fallen.
    expect(result.stats.pairsScored).toBeGreaterThanOrEqual(result.stats.matchedPairs);
  });

  it("scores nothing when either side is empty", () => {
    expect(reconcile([], []).stats.pairsScored).toBe(0);
    expect(reconcile([book("B", "2026-05-10", 100)], []).stats.pairsScored).toBe(0);
    expect(reconcile([], [line("S", "2026-05-10", 100)]).stats.pairsScored).toBe(0);
  });
});

describe("a year of a busy account is affordable", () => {
  it("reconciles several hundred lines a side well inside a second", () => {
    const generated = generateBooks({ seed: 1, months: 12, invoicesPerMonth: 30 });
    const books = bankView(generated.ledger, generated.bankAccount);
    expect(books.length).toBeGreaterThan(600);
    expect(generated.statement.length).toBeGreaterThan(600);

    const started = performance.now();
    const result = reconcile(books, generated.statement);
    const elapsed = performance.now() - started;

    // Generously above what it actually takes, because a timing assertion that
    // is tight is a timing assertion that fails on someone else's laptop. The
    // point is the order of magnitude: this took over sixteen seconds before
    // the pair index and the group direction bound went in.
    expect(elapsed).toBeLessThan(5000);

    const accuracy = measureAccuracy(result, generated.truth);
    expect(accuracy.precision).toBe(1);
    expect(accuracy.recallWithSuggestions).toBeGreaterThan(0.9);
  });

  it("keeps its accuracy as the books grow", () => {
    for (const months of [1, 3, 6, 12]) {
      const generated = generateBooks({ seed: 4, months, invoicesPerMonth: 10 });
      const books = bankView(generated.ledger, generated.bankAccount);
      const accuracy = measureAccuracy(reconcile(books, generated.statement), generated.truth);
      expect(accuracy.precision).toBe(1);
      expect(accuracy.recallWithSuggestions).toBeGreaterThan(0.85);
    }
  });
});
