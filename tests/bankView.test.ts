import { describe, expect, it } from "vitest";
import { JournalEntry, Ledger, date, dateRange } from "../src/ledger/index.js";
import { GBP, Money, USD } from "../src/money/index.js";
import { standardChart } from "../src/accounts/index.js";
import {
  bankView,
  bookLineTotal,
  isMoneyInBook,
  isMoneyOutBook,
} from "../src/reconcile/bankView.js";
import { demoLedger } from "../src/demo/month.js";

const gbp = (text: string) => Money.parse(text, GBP);
const chart = standardChart(GBP);

function books(): Ledger {
  return Ledger.empty(chart)
    .post(
      JournalEntry.simple({
        id: "A",
        date: "2026-08-01",
        narration: "Share capital",
        debit: "1110",
        credit: "3100",
        amount: gbp("10000.00"),
      }),
    )
    .post(
      JournalEntry.simple({
        id: "B",
        date: "2026-08-04",
        narration: "August rent",
        debit: "5300",
        credit: "1110",
        amount: gbp("950.00"),
        reference: "DD-RENT-08",
      }),
    )
    .post(
      JournalEntry.create({
        id: "C",
        date: "2026-08-09",
        narration: "Software licence",
        postings: [
          { account: "5400", amount: gbp("240.00"), memo: "split by project" },
          { account: "1110", amount: gbp("-240.00"), memo: "TOOLCHAIN LTD SUB9931" },
        ],
      }),
    );
}

describe("bankView", () => {
  it("flattens postings against one account into cash movements", () => {
    const lines = bankView(books(), "1110");
    expect(lines.map((l) => l.id)).toEqual(["A#0", "B#1", "C#1"]);
    expect(lines.map((l) => l.amount.toDecimalString())).toEqual(["10000.00", "-950.00", "-240.00"]);
  });

  it("uses the statement sign convention: positive is money in", () => {
    const lines = bankView(books(), "1110");
    expect(isMoneyInBook(lines[0] as never)).toBe(true);
    expect(isMoneyOutBook(lines[1] as never)).toBe(true);
    expect(lines.every((l) => l.account === "1110")).toBe(true);
  });

  it("flips the sign for a liability account, where a credit is money in", () => {
    const card = Ledger.empty(chart).post(
      JournalEntry.simple({
        id: "D",
        date: "2026-08-02",
        narration: "Card purchase",
        debit: "5400",
        credit: "2100",
        amount: gbp("60.00"),
      }),
    );
    const asPosted = bankView(card, "2100");
    const asCard = bankView(card, "2100", { inflowSign: -1 });
    expect(asPosted[0]?.amount.toDecimalString()).toBe("-60.00");
    expect(asCard[0]?.amount.toDecimalString()).toBe("60.00");
  });

  it("carries the entry reference and the contra accounts", () => {
    const lines = bankView(books(), "1110");
    expect(lines[1]?.reference).toBe("DD-RENT-08");
    expect(lines[1]?.contraAccounts).toEqual(["5300"]);
    expect(lines[0]?.reference).toBeNull();
    expect(lines[0]?.contraAccounts).toEqual(["3100"]);
  });

  it("appends a posting memo to the narration when it adds something", () => {
    const lines = bankView(books(), "1110");
    expect(lines[2]?.description).toBe("Software licence — TOOLCHAIN LTD SUB9931");
    expect(lines[2]?.normalisedDescription).toContain("SUB9931");
    // A blank memo leaves the narration alone.
    expect(lines[0]?.description).toBe("Share capital");
  });

  it("returns nothing for an account with no postings", () => {
    expect(bankView(books(), "1120")).toEqual([]);
    expect(bankView(Ledger.empty(chart), "1110")).toEqual([]);
  });

  it("filters by date range", () => {
    const lines = bankView(books(), "1110", { range: dateRange("2026-08-02", "2026-08-08") });
    expect(lines.map((l) => l.entryId)).toEqual(["B"]);
  });

  it("filters by currency", () => {
    const multi = books().post(
      JournalEntry.simple({
        id: "E",
        date: "2026-08-11",
        narration: "Dollar receipt",
        debit: "1110",
        credit: "4100",
        amount: Money.parse("500.00", USD),
      }),
    );
    expect(bankView(multi, "1110").map((l) => l.entryId)).toEqual(["A", "B", "C", "E"]);
    expect(bankView(multi, "1110", { currency: "GBP" }).map((l) => l.entryId)).toEqual([
      "A",
      "B",
      "C",
    ]);
    expect(bankView(multi, "1110", { currency: "usd" }).map((l) => l.entryId)).toEqual(["E"]);
  });

  it("is in chronological order even when entries were posted out of order", () => {
    const shuffled = books().post(
      JournalEntry.simple({
        id: "Z",
        date: "2026-08-02",
        narration: "Late-posted, early-dated",
        debit: "5300",
        credit: "1110",
        amount: gbp("12.00"),
      }),
    );
    const dates = bankView(shuffled, "1110").map((l) => l.date);
    expect(dates).toEqual([...dates].sort());
    expect(dates[1]).toBe(date("2026-08-02"));
  });
});

describe("bankView and reversals", () => {
  const withReversal = () =>
    books().reverse("B", { id: "B-REV", date: "2026-08-06", narration: "Reverse rent" });

  it("keeps both legs by default, because the bank may have seen both", () => {
    const lines = bankView(withReversal(), "1110");
    expect(lines.map((l) => l.entryId)).toEqual(["A", "B", "B-REV", "C"]);
    expect(lines[1]?.reversedBy).toBe("B-REV");
    expect(lines[2]?.reverses).toBe("B");
  });

  it("drops both legs on request, leaving the live movements", () => {
    const lines = bankView(withReversal(), "1110", { includeReversed: false });
    expect(lines.map((l) => l.entryId)).toEqual(["A", "C"]);
  });

  it("nets to the same total whether or not the reversed pair is included", () => {
    const all = bookLineTotal(bankView(withReversal(), "1110"));
    const live = bookLineTotal(bankView(withReversal(), "1110", { includeReversed: false }));
    expect(all).toBe(live);
  });
});

describe("bankView over the worked month", () => {
  const lines = bankView(demoLedger(), "1110");

  it("finds every movement through the current account", () => {
    expect(lines.length).toBe(10);
    expect(lines.every((l) => l.amount.currency.code === "GBP")).toBe(true);
  });

  it("sums to the ledger's own balance for that account", () => {
    expect(bookLineTotal(lines)).toBe(demoLedger().balanceOf("1110").minorUnits);
  });

  it("gives every line a unique id", () => {
    expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length);
  });

  it("normalises descriptions the same way statement lines are normalised", () => {
    const rent = lines.find((l) => l.entryId === "JE-003");
    expect(rent?.normalisedDescription).toBe("AUGUST RENT");
  });
});
