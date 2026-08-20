import { describe, expect, it } from "vitest";
import { EUR, GBP } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { JournalEntry } from "../src/ledger/entry.js";
import { Ledger } from "../src/ledger/ledger.js";
import { trialBalance } from "../src/ledger/trialBalance.js";
import { CloseError, closingEntry, resultOver, withResultClosed } from "../src/ledger/close.js";
import { standardChart } from "../src/accounts/standard.js";
import { date as day } from "../src/ledger/date.js";
import { nordLedger } from "../src/demo/group.js";

const chart = standardChart(GBP);
const entry = (id: string, date: string, debit: string, credit: string, amount: string) =>
  JournalEntry.simple(
    { id, date, narration: id, debit, credit, amount: Money.parse(amount, GBP) },
    chart,
  );

function trading(): Ledger {
  return Ledger.from(
    [
      entry("A", "2026-01-10", "1110", "3100", "100000.00"),
      entry("B", "2026-02-20", "1110", "4100", "80000.00"),
      entry("C", "2026-03-15", "5100", "1110", "30000.00"),
      entry("D", "2026-07-01", "1110", "4100", "120000.00"),
      entry("E", "2026-08-01", "5200", "1110", "45000.00"),
    ],
    chart,
  );
}

describe("the entry that closes the books", () => {
  const books = trading();

  it("takes every income and expense balance off at the date asked for", () => {
    const closing = closingEntry(books, "2026-03-31") as JournalEntry;
    const accounts = closing.postings.map((p) => p.account).sort();
    expect(accounts).toEqual(["3200", "4100", "5100"]);
    // 5200 had not moved by March, so it is not in the entry at all.
    expect(accounts).not.toContain("5200");
  });

  it("carries the result to reserves and balances", () => {
    const closing = closingEntry(books, "2026-03-31") as JournalEntry;
    const reserves = closing.postings.find((p) => p.account === "3200");
    // 80,000 earned less 30,000 spent is a 50,000 profit, credited to reserves.
    expect(reserves?.amount.toDecimalString()).toBe("-50000.00");
    const total = closing.postings.reduce((running, p) => running.plus(p.amount), Money.zero(GBP));
    expect(total.isZero).toBe(true);
  });

  it("dates the entry at the closing date and says what it is", () => {
    const closing = closingEntry(books, "2026-03-31") as JournalEntry;
    expect(closing.date).toBe("2026-03-31");
    expect(closing.id).toBe("CLOSE-2026-03-31");
    expect(closing.narration).toContain("closed to reserves");
    expect(closing.tags).toContain("close");
  });

  it("takes an id, a narration and a reserves account when the caller has one", () => {
    const closing = closingEntry(books, "2026-03-31", {
      id: "PRE-ACQ-S",
      narration: "before anybody in the group controlled it",
      reserves: "3300",
      tags: ["consolidation"],
    }) as JournalEntry;
    expect(closing.id).toBe("PRE-ACQ-S");
    expect(closing.narration).toBe("before anybody in the group controlled it");
    expect(closing.postings.some((p) => p.account === "3300")).toBe(true);
    expect(closing.postings.some((p) => p.account === "3200")).toBe(false);
    expect(closing.tags).toEqual(["consolidation"]);
  });

  it("is null where there is nothing to close", () => {
    expect(closingEntry(books, "2025-12-31")).toBeNull();
    expect(closingEntry(Ledger.empty(chart), "2026-12-31")).toBeNull();
  });

  it("is null again once the books have been closed at that date", () => {
    const closed = withResultClosed(books, "2026-03-31");
    expect(closingEntry(closed, "2026-03-31")).toBeNull();
  });

  it("still produces an entry when income and expense cancel exactly", () => {
    const flat = Ledger.from(
      [
        entry("A", "2026-01-10", "1110", "3100", "100000.00"),
        entry("B", "2026-02-20", "1110", "4100", "40000.00"),
        entry("C", "2026-03-15", "5100", "1110", "40000.00"),
      ],
      chart,
    );
    const closing = closingEntry(flat, "2026-03-31") as JournalEntry;
    // Both sides have to come off; there is simply no result to carry across,
    // and a posting for zero would be rejected.
    expect(closing.postings.map((p) => p.account).sort()).toEqual(["4100", "5100"]);
    expect(closing.postings.some((p) => p.account === "3200")).toBe(false);
  });
});

describe("the books with the result closed", () => {
  const books = trading();

  it("leaves the original alone", () => {
    const before = books.size;
    withResultClosed(books, "2026-03-31");
    expect(books.size).toBe(before);
    expect(books.has("CLOSE-2026-03-31")).toBe(false);
  });

  it("still balances afterwards, at the closing date and at any later one", () => {
    const closed = withResultClosed(books, "2026-03-31");
    expect(() => closed.verify()).not.toThrow();
    for (const asAt of ["2026-03-31", "2026-06-30", "2026-12-31"]) {
      const balances = trialBalance(closed, { currency: GBP, asAt: day(asAt) });
      expect(balances.balanced).toBe(true);
      expect(balances.difference.isZero).toBe(true);
    }
  });

  it("moves nothing off the balance sheet", () => {
    const closed = withResultClosed(books, "2026-03-31");
    expect(closed.balanceAsAt("1110", day("2026-12-31"), GBP).toDecimalString()).toBe(
      books.balanceAsAt("1110", day("2026-12-31"), GBP).toDecimalString(),
    );
  });

  it("comes back unchanged where there is nothing to close", () => {
    expect(withResultClosed(books, "2025-12-31")).toBe(books);
  });

  it("refuses to close twice at the same date under the same id", () => {
    const closed = withResultClosed(books, "2026-03-31");
    // Nothing left to close at March, so a second call is a no-op — but a
    // ledger that has traded since and carries the id already is an error.
    const traded = closed.post(entry("F", "2026-03-20", "1110", "4100", "5000.00"));
    expect(() => withResultClosed(traded, "2026-03-31")).toThrow(CloseError);
    expect(() => withResultClosed(traded, "2026-03-31")).toThrow(/closed at 2026-03-31 once/);
  });

  it("leaves this period's result on the income accounts", () => {
    const closed = withResultClosed(books, "2026-03-31");
    // 120,000 earned less 45,000 spent after March.
    expect(closed.balanceAsAt("4100", day("2026-12-31"), GBP).toDecimalString()).toBe("-120000.00");
    expect(closed.balanceAsAt("5200", day("2026-12-31"), GBP).toDecimalString()).toBe("45000.00");
    // And the whole year's profit is still the whole year's profit.
    expect(closed.balanceAsAt("3200", day("2026-12-31"), GBP).toDecimalString()).toBe("-50000.00");
  });
});

describe("the result over a window", () => {
  const books = trading();

  it("is what the income accounts moved between the two dates", () => {
    expect(resultOver(books, "2026-03-31", "2026-12-31").toDecimalString()).toBe("75000.00");
    expect(resultOver(books, "2025-12-31", "2026-12-31").toDecimalString()).toBe("125000.00");
    expect(resultOver(books, "2025-12-31", "2026-03-31").toDecimalString()).toBe("50000.00");
  });

  it("splits the year in two with nothing lost between the halves", () => {
    const first = resultOver(books, "2025-12-31", "2026-06-30");
    const second = resultOver(books, "2026-06-30", "2026-12-31");
    const whole = resultOver(books, "2025-12-31", "2026-12-31");
    expect(first.plus(second).equals(whole)).toBe(true);
  });

  it("works on books kept in another currency", () => {
    // Nord's intercompany purchase falls in March, so the nine months after it
    // are 560,000 less 395,000 less 84,000.
    expect(resultOver(nordLedger(), "2026-03-31", "2026-12-31", { currency: EUR }).toDecimalString()).toBe(
      "81000.00",
    );
    expect(resultOver(nordLedger(), "2025-12-31", "2026-12-31", { currency: EUR }).toDecimalString()).toBe(
      "8710.84",
    );
  });

  it("is nil over a window nothing happened in", () => {
    expect(resultOver(books, "2026-03-31", "2026-06-30").isZero).toBe(true);
  });
});
