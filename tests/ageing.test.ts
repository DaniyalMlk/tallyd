import { describe, expect, it } from "vitest";
import { GBP, Money } from "../src/money/index.js";
import { JournalEntry, Ledger, addDays, date } from "../src/ledger/index.js";
import { standardChart } from "../src/accounts/index.js";
import { ageing, openItems, renderAgeing } from "../src/reports/ageing.js";
import {
  EXPECTED_OPEN_ITEMS,
  RECEIVABLE_INVOICES,
  receivablesLedger,
} from "../src/demo/receivables.js";

const gbp = (text: string) => Money.parse(text, GBP);
const chart = standardChart(GBP);

function sales(): Ledger {
  return Ledger.empty(chart)
    .post(
      JournalEntry.simple({
        id: "INV-1",
        date: "2026-06-01",
        narration: "Acme — INV-1",
        debit: "1130",
        credit: "4200",
        amount: gbp("1000.00"),
        reference: "INV-1",
      }),
    )
    .post(
      JournalEntry.simple({
        id: "INV-2",
        date: "2026-08-15",
        narration: "Beta — INV-2",
        debit: "1130",
        credit: "4200",
        amount: gbp("500.00"),
        reference: "INV-2",
      }),
    )
    .post(
      JournalEntry.simple({
        id: "RCT-1",
        date: "2026-08-20",
        narration: "Receipt against INV-2",
        debit: "1110",
        credit: "1130",
        amount: gbp("500.00"),
        reference: "INV-2",
      }),
    );
}

describe("openItems", () => {
  it("keeps what is outstanding and drops what has been settled", () => {
    const items = openItems(sales(), "1130", date("2026-09-01"));
    expect(items.map((i) => i.reference)).toEqual(["INV-1"]);
    expect(items[0]?.outstanding.toDecimalString()).toBe("1000.00");
  });

  it("nets a part payment and still ages from when the invoice was raised", () => {
    const part = sales().post(
      JournalEntry.simple({
        id: "RCT-2",
        date: "2026-08-31",
        narration: "Part payment",
        debit: "1110",
        credit: "1130",
        amount: gbp("400.00"),
        reference: "INV-1",
      }),
    );
    const items = openItems(part, "1130", date("2026-09-01"));
    expect(items[0]?.outstanding.toDecimalString()).toBe("600.00");
    expect(items[0]?.raisedAmount.toDecimalString()).toBe("1000.00");
    expect(items[0]?.raised).toBe(date("2026-06-01"));
    expect(items[0]?.lastMovement).toBe(date("2026-08-31"));
    // 92 days from 1 June to 1 September, not 1 day from the part payment.
    expect(items[0]?.daysOutstanding).toBe(92);
  });

  it("reports an overpayment as a negative item rather than hiding it", () => {
    const over = sales().post(
      JournalEntry.simple({
        id: "RCT-2",
        date: "2026-08-31",
        narration: "Overpayment",
        debit: "1110",
        credit: "1130",
        amount: gbp("1100.00"),
        reference: "INV-1",
      }),
    );
    const items = openItems(over, "1130", date("2026-09-01"));
    expect(items.map((i) => [i.reference, i.outstanding.toDecimalString()])).toEqual([
      ["INV-1", "-100.00"],
    ]);
  });

  it("ignores anything after the as-at date", () => {
    const asOfJuly = openItems(sales(), "1130", date("2026-07-01"));
    expect(asOfJuly.map((i) => i.reference)).toEqual(["INV-1"]);

    const beforeAnything = openItems(sales(), "1130", date("2026-05-31"));
    expect(beforeAnything).toEqual([]);
  });

  it("falls back to the entry id when an entry carries no reference", () => {
    const unreferenced = Ledger.empty(chart).post(
      JournalEntry.simple({
        id: "JE-99",
        date: "2026-06-01",
        narration: "Sundry debtor",
        debit: "1130",
        credit: "4200",
        amount: gbp("75.00"),
      }),
    );
    expect(openItems(unreferenced, "1130", date("2026-09-01"))[0]?.reference).toBe("JE-99");
  });

  it("ages two invoices to the same customer separately", () => {
    const twice = sales().post(
      JournalEntry.simple({
        id: "INV-3",
        date: "2026-08-25",
        narration: "Acme — INV-3",
        debit: "1130",
        credit: "4200",
        amount: gbp("250.00"),
        reference: "INV-3",
      }),
    );
    const items = openItems(twice, "1130", date("2026-09-01"));
    expect(items.map((i) => i.daysOutstanding)).toEqual([92, 7]);
  });

  it("flips the sign for a payables account so an amount owed reads positive", () => {
    const payables = Ledger.empty(chart).post(
      JournalEntry.simple({
        id: "BILL-1",
        date: "2026-08-01",
        narration: "Supplier bill",
        debit: "5700",
        credit: "2100",
        amount: gbp("340.00"),
        reference: "BILL-1",
      }),
    );
    const items = openItems(payables, "2100", date("2026-09-01"));
    expect(items[0]?.outstanding.toDecimalString()).toBe("340.00");
  });

  it("honours a minimum, for writing off rounding dust", () => {
    const dusty = sales().post(
      JournalEntry.simple({
        id: "RCT-2",
        date: "2026-08-31",
        narration: "Almost all of it",
        debit: "1110",
        credit: "1130",
        amount: gbp("999.99"),
        reference: "INV-1",
      }),
    );
    expect(openItems(dusty, "1130", date("2026-09-01"))).toHaveLength(1);
    expect(
      openItems(dusty, "1130", date("2026-09-01"), { minimumMinorUnits: 1n }),
    ).toHaveLength(0);
  });

  it("returns nothing for an account with no postings", () => {
    expect(openItems(sales(), "1120", date("2026-09-01"))).toEqual([]);
  });
});

describe("ageing buckets", () => {
  it("uses 0-30 / 31-60 / 61-90 / 91+ by default", () => {
    expect(ageing(sales(), "1130", date("2026-09-01")).buckets.map((b) => b.label)).toEqual([
      "0-30",
      "31-60",
      "61-90",
      "91+",
    ]);
  });

  it("places an item on each side of every boundary, and on the boundary itself", () => {
    // One invoice per target age, raised so that the as-at date lands exactly
    // on 29, 30, 31, 60, 61, 90 and 91 days.
    const ages = [29, 30, 31, 60, 61, 90, 91];
    let ledger = Ledger.empty(chart);
    for (const age of ages) {
      const raised = addDays(date("2026-09-30"), -age);
      ledger = ledger.post(
        JournalEntry.simple({
          id: `INV-${age}`,
          date: raised,
          narration: `Aged ${age}`,
          debit: "1130",
          credit: "4200",
          amount: gbp("100.00"),
          reference: `INV-${age}`,
        }),
      );
    }

    const report = ageing(ledger, "1130", date("2026-09-30"));
    const byLabel = new Map(report.buckets.map((b) => [b.label, b.items.map((i) => i.daysOutstanding)]));
    expect(byLabel.get("0-30")).toEqual([30, 29]);
    expect(byLabel.get("31-60")).toEqual([60, 31]);
    expect(byLabel.get("61-90")).toEqual([90, 61]);
    expect(byLabel.get("91+")).toEqual([91]);
  });

  it("accepts custom boundaries", () => {
    const report = ageing(sales(), "1130", date("2026-09-01"), { boundaries: [7, 14] });
    expect(report.buckets.map((b) => b.label)).toEqual(["0-7", "8-14", "15+"]);
    expect(report.buckets.at(-1)?.total.toDecimalString()).toBe("1000.00");
  });

  it("puts every item in exactly one bucket, and the buckets sum to the total", () => {
    const report = ageing(receivablesLedger(), "1130", date("2026-09-30"));
    const bucketed = report.buckets.flatMap((b) => b.items.map((i) => i.reference));
    expect(bucketed.sort()).toEqual(report.items.map((i) => i.reference).sort());
    expect(new Set(bucketed).size).toBe(bucketed.length);

    const summed = report.buckets.reduce((sum, b) => sum + b.total.minorUnits, 0n);
    expect(summed).toBe(report.total.minorUnits);
  });

  it("totals to the account's own ledger balance", () => {
    const ledger = receivablesLedger();
    const report = ageing(ledger, "1130", date("2026-09-30"));
    expect(report.total.minorUnits).toBe(ledger.balanceOf("1130").minorUnits);
  });
});

describe("ageing over the receivables quarter", () => {
  const report = ageing(receivablesLedger(), "1130", date("2026-09-30"));

  it("matches the hand-worked expectations", () => {
    expect(
      report.items.map((item) => ({
        reference: item.reference,
        outstanding: item.outstanding.toDecimalString(),
        days: item.daysOutstanding,
      })),
    ).toEqual(
      EXPECTED_OPEN_ITEMS.map((expected) => ({
        reference: expected.reference,
        outstanding: expected.outstanding,
        days: expected.days,
      })),
    );
  });

  it("drops the three invoices that were settled in full", () => {
    const outstanding = new Set(report.items.map((i) => i.reference));
    for (const settled of ["INV-2002", "INV-2004", "INV-2006"]) {
      expect(outstanding.has(settled)).toBe(false);
    }
    expect(RECEIVABLE_INVOICES).toHaveLength(7);
    expect(report.items).toHaveLength(4);
  });

  it("renders a readable schedule", () => {
    const text = renderAgeing(report);
    expect(text).toContain("Ageing — 1130 Accounts Receivable (GBP) as at 2026-09-30");
    expect(text).toContain("INV-2001");
    expect(text).toContain("2800.00");
    expect(text).toContain("91+");
  });

  it("says so plainly when there is nothing outstanding", () => {
    expect(renderAgeing(ageing(sales(), "1120", date("2026-09-01")))).toContain(
      "Nothing outstanding.",
    );
  });
});
