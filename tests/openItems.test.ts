/**
 * The case that makes per-item revaluation necessary: one account, two
 * invoices, booked at different rates, revalued together and settled apart.
 *
 * Adjusting the account as a single balance passes every obvious test — the
 * balance sheet is right, the entry balances, the trial balance agrees — and is
 * still wrong, because the adjustment ends up attributable to the account and
 * not to either invoice. Settling one of them afterwards then measures against
 * what it was originally booked at, and the rate movement between the invoice
 * and the close gets counted twice: once as unrealised, once as realised.
 */

import { describe, expect, it } from "vitest";
import { ChartOfAccounts } from "../src/accounts/chart.js";
import { STANDARD_ACCOUNTS } from "../src/accounts/standard.js";
import { JournalEntry } from "../src/ledger/entry.js";
import { Ledger } from "../src/ledger/ledger.js";
import { trialBalance } from "../src/ledger/trialBalance.js";
import { EUR, GBP } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { RateTable } from "../src/fx/table.js";
import { type OpenItem, exposures, openItems } from "../src/fx/exposure.js";
import { type RevaluationLine, applyRevaluation, revalue } from "../src/fx/revaluation.js";
import { applySettlement, settleForeignItem } from "../src/fx/settlement.js";

const CHART = ChartOfAccounts.build(
  [
    ...STANDARD_ACCOUNTS,
    { code: "1131", name: "Receivable (EUR)", type: "asset", parent: "1100", currency: "EUR" },
  ],
  { currency: "GBP" },
);

const RATES = RateTable.of([
  { date: "2026-01-20", base: "EUR", quote: "GBP", rate: "0.8400" },
  { date: "2026-02-15", base: "EUR", quote: "GBP", rate: "0.8500" },
  { date: "2026-03-31", base: "EUR", quote: "GBP", rate: "0.8600" },
  { date: "2026-04-20", base: "EUR", quote: "GBP", rate: "0.8700" },
]);

function invoice(id: string, when: string, foreign: string, booked: string): JournalEntry {
  return JournalEntry.create({
    id,
    date: when,
    narration: "Invoice — Blauwe Zee BV",
    reference: id,
    postings: [
      { account: "1131", amount: Money.parse(booked, GBP), foreign: Money.parse(foreign, EUR) },
      { account: "4200", amount: Money.parse(`-${booked}`, GBP) },
    ],
  });
}

/** 1,000 EUR at 0.8400 in January, then 500 EUR at 0.8500 in February. */
function twoInvoices(): Ledger {
  return Ledger.from(
    [
      invoice("INV-014", "2026-01-20", "1000.00", "840.00"),
      invoice("INV-021", "2026-02-15", "500.00", "425.00"),
    ],
    CHART,
  );
}

describe("one account, two rates", () => {
  it("has no single rate it was booked at", () => {
    const account = exposures(twoInvoices())[0] as { impliedRate: { toDecimalString: (n: number) => string } | null };
    expect(account.impliedRate?.toDecimalString(6)).toBe("0.843333");
  });

  it("breaks into the items it is made of", () => {
    const items = openItems(twoInvoices());
    expect(items.map((i) => i.reference)).toEqual(["INV-014", "INV-021"]);
    expect((items[0] as OpenItem).impliedRate?.toDecimalString(4)).toBe("0.8400");
    expect((items[1] as OpenItem).impliedRate?.toDecimalString(4)).toBe("0.8500");
  });

  it("still sums to the account balance", () => {
    const items = openItems(twoInvoices());
    const account = exposures(twoInvoices())[0] as { foreignBalance: Money; carryingAmount: Money };
    expect(
      items.reduce((total, i) => total.plus(i.foreignBalance), Money.zero(EUR)).toString(),
    ).toBe(account.foreignBalance.toString());
    expect(
      items.reduce((total, i) => total.plus(i.carryingAmount), Money.zero(GBP)).toString(),
    ).toBe(account.carryingAmount.toString());
  });

  it("groups movements with no reference into an item of their own", () => {
    const withStray = twoInvoices().record({
      id: "ADJ-1",
      date: "2026-02-20",
      narration: "Rounding adjustment",
      postings: [
        { account: "1131", amount: Money.parse("0.85", GBP), foreign: Money.parse("1.00", EUR) },
        { account: "4200", amount: Money.parse("-0.85", GBP) },
      ],
    });
    const items = openItems(withStray);
    expect(items.map((i) => i.reference)).toEqual([null, "INV-014", "INV-021"]);
  });
});

describe("revaluing them", () => {
  it("adjusts each invoice to the closing rate on its own line", () => {
    const result = revalue(twoInvoices(), { asAt: "2026-03-31", rates: RATES });
    expect(result.lines).toHaveLength(2);
    const [first, second] = result.lines as unknown as [RevaluationLine, RevaluationLine];
    expect(first.reference).toBe("INV-014");
    expect(first.adjustment.toString()).toBe("20.00 GBP");
    expect(second.reference).toBe("INV-021");
    expect(second.adjustment.toString()).toBe("5.00 GBP");
    expect(result.net.toString()).toBe("25.00 GBP");
  });

  it("stamps each adjustment with the item it belongs to", () => {
    const entry = revalue(twoInvoices(), { asAt: "2026-03-31", rates: RATES }).entry as JournalEntry;
    const references = entry.postings.map((p) => p.reference);
    expect(references).toEqual(["INV-014", "INV-021", null]);
  });

  it("leaves every item carried at the closing rate", () => {
    const after = applyRevaluation(twoInvoices(), { asAt: "2026-03-31", rates: RATES });
    for (const item of openItems(after)) {
      expect(item.impliedRate?.toDecimalString(4)).toBe("0.8600");
    }
  });

  it("is still a no-op run twice", () => {
    const once = applyRevaluation(twoInvoices(), { asAt: "2026-03-31", rates: RATES });
    expect(revalue(once, { asAt: "2026-03-31", rates: RATES }).entry).toBeNull();
  });
});

describe("settling one of them afterwards", () => {
  it("measures against the closing rate, not the invoice rate", () => {
    const revalued = applyRevaluation(twoInvoices(), { asAt: "2026-03-31", rates: RATES });
    const settled = settleForeignItem(revalued, {
      id: "RCT-021",
      date: "2026-04-20",
      account: "1131",
      bankAccount: "1110",
      reference: "INV-021",
      rates: RATES,
    });
    // Booked at 0.8500, revalued to 0.8600, received at 0.8700. Only the last
    // leg is realised here; the middle one was booked in the first quarter.
    expect(settled.carriedAt.toString()).toBe("430.00 GBP");
    expect(settled.carryingRate.toDecimalString(4)).toBe("0.8600");
    expect(settled.realised.toString()).toBe("5.00 GBP");
  });

  it("counts the whole rate movement exactly once", () => {
    const revalued = applyRevaluation(twoInvoices(), { asAt: "2026-03-31", rates: RATES });
    const after = applySettlement(revalued, {
      id: "RCT-021",
      date: "2026-04-20",
      account: "1131",
      bankAccount: "1110",
      reference: "INV-021",
      rates: RATES,
    });
    // INV-014: 1,000 EUR, 0.8400 -> 0.8600, unrealised 20.00.
    // INV-021:   500 EUR, 0.8500 -> 0.8700, of which 5.00 unrealised and
    //                                        5.00 realised.
    expect(after.accountBalance("4400", "GBP").natural.toString()).toBe("30.00 GBP");
    expect(after.accountBalance("1110", "GBP").balance.toString()).toBe("435.00 GBP");
    expect(trialBalance(after, { currency: GBP }).balanced).toBe(true);
  });

  it("leaves the other invoice carried at the close, not at a blend", () => {
    const after = applySettlement(
      applyRevaluation(twoInvoices(), { asAt: "2026-03-31", rates: RATES }),
      {
        id: "RCT-021",
        date: "2026-04-20",
        account: "1131",
        bankAccount: "1110",
        reference: "INV-021",
        rates: RATES,
      },
    );
    const remaining = openItems(after);
    expect(remaining).toHaveLength(1);
    expect((remaining[0] as OpenItem).reference).toBe("INV-014");
    expect((remaining[0] as OpenItem).carryingAmount.toString()).toBe("860.00 GBP");
    expect((remaining[0] as OpenItem).impliedRate?.toDecimalString(4)).toBe("0.8600");
  });

  it("reaches the same total whichever order the two are settled in", () => {
    const revalued = applyRevaluation(twoInvoices(), { asAt: "2026-03-31", rates: RATES });
    const settle = (ledger: Ledger, reference: string, id: string): Ledger =>
      applySettlement(ledger, {
        id,
        date: "2026-04-20",
        account: "1131",
        bankAccount: "1110",
        reference,
        rates: RATES,
      });

    // 25.00 unrealised at the close, then 10.00 and 5.00 realised in April.
    const forwards = settle(settle(revalued, "INV-014", "A"), "INV-021", "B");
    const backwards = settle(settle(revalued, "INV-021", "B"), "INV-014", "A");
    expect(forwards.accountBalance("4400", "GBP").natural.toString()).toBe("40.00 GBP");
    expect(backwards.accountBalance("4400", "GBP").natural.toString()).toBe("40.00 GBP");
    expect(openItems(forwards)).toHaveLength(0);
    expect(openItems(backwards)).toHaveLength(0);
  });

  it("agrees with settling both without ever revaluing", () => {
    const settle = (ledger: Ledger, reference: string, id: string): Ledger =>
      applySettlement(ledger, {
        id,
        date: "2026-04-20",
        account: "1131",
        bankAccount: "1110",
        reference,
        rates: RATES,
      });
    const never = settle(settle(twoInvoices(), "INV-014", "A"), "INV-021", "B");
    // 1,000 EUR from 0.8400 to 0.8700 is 30.00; 500 EUR from 0.8500 to 0.8700
    // is 10.00. Whether any of it was booked as unrealised first cannot change
    // the total.
    expect(never.accountBalance("4400", "GBP").natural.toString()).toBe("40.00 GBP");
  });
});
