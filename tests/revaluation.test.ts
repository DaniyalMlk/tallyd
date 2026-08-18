import { describe, expect, it } from "vitest";
import { ChartOfAccounts } from "../src/accounts/chart.js";
import { STANDARD_ACCOUNTS } from "../src/accounts/standard.js";
import { JournalEntry } from "../src/ledger/entry.js";
import { Ledger } from "../src/ledger/ledger.js";
import { trialBalance } from "../src/ledger/trialBalance.js";
import { date } from "../src/ledger/date.js";
import { EUR, GBP, USD } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { RateTable } from "../src/fx/table.js";
import { exposures, renderExposures } from "../src/fx/exposure.js";
import {
  type RevaluationLine,
  RevaluationError,
  applyRevaluation,
  renderRevaluation,
  revalue,
} from "../src/fx/revaluation.js";
import type { Exposure } from "../src/fx/exposure.js";

const CHART = ChartOfAccounts.build(
  [
    ...STANDARD_ACCOUNTS,
    { code: "1131", name: "Accounts Receivable (EUR)", type: "asset", parent: "1100", currency: "EUR" },
    { code: "2101", name: "Accounts Payable (USD)", type: "liability", parent: "2000", currency: "USD" },
  ],
  { currency: "GBP" },
);

const RATES = RateTable.of(
  [
    // 20 January: the euro buys 0.8400, the dollar 0.7800.
    { date: "2026-01-20", base: "EUR", quote: "GBP", rate: "0.8400" },
    { date: "2026-01-20", base: "USD", quote: "GBP", rate: "0.7800" },
    // 31 March: the euro has strengthened, the dollar has weakened.
    { date: "2026-03-31", base: "EUR", quote: "GBP", rate: "0.8600" },
    { date: "2026-03-31", base: "USD", quote: "GBP", rate: "0.7700" },
    { date: "2026-06-30", base: "EUR", quote: "GBP", rate: "0.8500" },
    { date: "2026-06-30", base: "USD", quote: "GBP", rate: "0.7700" },
  ],
  { maxStaleDays: 5 },
);

/** 1,000 EUR receivable booked at 0.8400, and a 500 USD payable at 0.7800. */
function books(): Ledger {
  return Ledger.from(
    [
      JournalEntry.create({
        id: "INV-014",
        date: "2026-01-20",
        narration: "Invoice — Blauwe Zee BV",
        reference: "INV-014",
        postings: [
          { account: "1131", amount: Money.parse("840.00", GBP), foreign: Money.parse("1000.00", EUR) },
          { account: "4200", amount: Money.parse("-840.00", GBP) },
        ],
      }),
      JournalEntry.create({
        id: "BILL-221",
        date: "2026-01-20",
        narration: "Bill — Redwood Systems Inc",
        reference: "BILL-221",
        postings: [
          { account: "5400", amount: Money.parse("390.00", GBP) },
          { account: "2101", amount: Money.parse("-390.00", GBP), foreign: Money.parse("-500.00", USD) },
        ],
      }),
    ],
    CHART,
  );
}

describe("what the books are exposed to", () => {
  it("finds every balance denominated in something else", () => {
    const list = exposures(books());
    expect(list.map((e) => e.account)).toEqual(["1131", "2101"]);
    expect((list[0] as Exposure).foreignBalance.toString()).toBe("1000.00 EUR");
    expect((list[0] as Exposure).carryingAmount.toString()).toBe("840.00 GBP");
  });

  it("reads a payable as the credit balance it is", () => {
    const payable = exposures(books())[1] as Exposure;
    expect(payable.foreignBalance.toString()).toBe("-500.00 USD");
    expect(payable.carryingAmount.toString()).toBe("-390.00 GBP");
  });

  it("recovers the rate each balance was booked at", () => {
    const list = exposures(books());
    expect((list[0] as Exposure).impliedRate?.toDecimalString(4)).toBe("0.8400");
    expect((list[1] as Exposure).impliedRate?.toDecimalString(4)).toBe("0.7800");
  });

  it("ignores accounts kept in the books' own currency", () => {
    const list = exposures(books());
    expect(list.map((e) => e.account)).not.toContain("4200");
    expect(list.map((e) => e.account)).not.toContain("5400");
  });

  it("drops a balance that has settled to nothing, unless asked for it", () => {
    const settled = books().record({
      id: "RCT-1",
      date: "2026-02-01",
      narration: "Receipt",
      postings: [
        { account: "1131", amount: Money.parse("-840.00", GBP), foreign: Money.parse("-1000.00", EUR) },
        { account: "1110", amount: Money.parse("840.00", GBP) },
      ],
    });
    expect(exposures(settled).map((e) => e.account)).toEqual(["2101"]);
    expect(exposures(settled, { includeSettled: true }).map((e) => e.account)).toEqual([
      "1131",
      "2101",
    ]);
  });

  it("stops at an as-at date", () => {
    const later = books().record({
      id: "INV-020",
      date: "2026-05-01",
      narration: "Invoice — Blauwe Zee BV",
      postings: [
        { account: "1131", amount: Money.parse("430.00", GBP), foreign: Money.parse("500.00", EUR) },
        { account: "4200", amount: Money.parse("-430.00", GBP) },
      ],
    });
    const atMarch = exposures(later, { asAt: date("2026-03-31") })[0] as Exposure;
    expect(atMarch.foreignBalance.toString()).toBe("1000.00 EUR");
  });

  it("renders as a table", () => {
    const text = renderExposures(exposures(books()), "GBP");
    expect(text).toContain("Accounts Receivable (EUR)");
    expect(text).toContain("1000.00 EUR");
    expect(text).toContain("0.840000");
    expect(renderExposures([], "GBP")).toBe("No foreign-currency balances.");
  });
});

describe("the period-end revaluation", () => {
  it("retranslates each balance at the closing rate", () => {
    const result = revalue(books(), { asAt: "2026-03-31", rates: RATES });
    const receivable = result.lines[0] as RevaluationLine;
    const payable = result.lines[1] as RevaluationLine;
    // 1,000 EUR at 0.8600 is 860.00, up from 840.00.
    expect(receivable.closingAmount.toString()).toBe("860.00 GBP");
    expect(receivable.adjustment.toString()).toBe("20.00 GBP");
    // -500 USD at 0.7700 is -385.00, up from -390.00: the payable shrank.
    expect(payable.closingAmount.toString()).toBe("-385.00 GBP");
    expect(payable.adjustment.toString()).toBe("5.00 GBP");
  });

  it("books the net to the gain account, in one balanced entry", () => {
    const result = revalue(books(), { asAt: "2026-03-31", rates: RATES });
    const entry = result.entry as JournalEntry;
    expect(result.net.toString()).toBe("25.00 GBP");
    expect(entry.postings).toHaveLength(3);
    expect(entry.amountFor("4400").toString()).toBe("-25.00 GBP");
    expect(entry.amountFor("1131").toString()).toBe("20.00 GBP");
    expect(entry.id).toBe("FX-REVAL-2026-03-31");
    expect(entry.tags).toEqual(["fx", "unrealised"]);
  });

  it("leaves the foreign balance alone, because nothing was paid", () => {
    const after = applyRevaluation(books(), { asAt: "2026-03-31", rates: RATES });
    const receivable = exposures(after)[0] as Exposure;
    expect(receivable.foreignBalance.toString()).toBe("1000.00 EUR");
    expect(receivable.carryingAmount.toString()).toBe("860.00 GBP");
  });

  it("leaves the trial balance agreeing", () => {
    const after = applyRevaluation(books(), { asAt: "2026-03-31", rates: RATES });
    expect(trialBalance(after, { currency: GBP }).balanced).toBe(true);
  });

  it("is a no-op the second time it is run on the same date", () => {
    const once = applyRevaluation(books(), { asAt: "2026-03-31", rates: RATES });
    const again = revalue(once, { asAt: "2026-03-31", rates: RATES, id: "FX-REVAL-again" });
    expect(again.entry).toBeNull();
    expect(again.net.toString()).toBe("0.00 GBP");
    expect(applyRevaluation(once, { asAt: "2026-03-31", rates: RATES }).size).toBe(once.size);
  });

  it("books only the movement since the last one when run again later", () => {
    const march = applyRevaluation(books(), { asAt: "2026-03-31", rates: RATES });
    const june = revalue(march, { asAt: "2026-06-30", rates: RATES });
    // The euro fell back from 0.8600 to 0.8500: a 10.00 loss on the receivable.
    // The dollar did not move, so the payable contributes nothing.
    expect(june.net.toString()).toBe("-10.00 GBP");
    expect((june.entry as JournalEntry).amountFor("5950").toString()).toBe("10.00 GBP");
  });

  it("reaches the same carrying amount whether or not the interim revaluation was posted", () => {
    const viaMarch = applyRevaluation(
      applyRevaluation(books(), { asAt: "2026-03-31", rates: RATES }),
      { asAt: "2026-06-30", rates: RATES },
    );
    const straightToJune = applyRevaluation(books(), { asAt: "2026-06-30", rates: RATES });
    const a = exposures(viaMarch)[0] as Exposure;
    const b = exposures(straightToJune)[0] as Exposure;
    expect(a.carryingAmount.toString()).toBe(b.carryingAmount.toString());
    expect(a.carryingAmount.toString()).toBe("850.00 GBP");
  });

  it("posts a gross gain and a gross loss when the two happen to net to zero", () => {
    const offsetting = RateTable.of([
      // The receivable gains 20.00; the payable is now worth 410.00 rather
      // than 390.00, so it loses exactly as much.
      { date: "2026-03-31", base: "EUR", quote: "GBP", rate: "0.8600" },
      { date: "2026-03-31", base: "USD", quote: "GBP", rate: "0.8200" },
    ]);
    const result = revalue(books(), { asAt: "2026-03-31", rates: offsetting });
    expect(result.net.toString()).toBe("0.00 GBP");
    expect(result.gain.toString()).toBe("20.00 GBP");
    expect(result.loss.toString()).toBe("20.00 GBP");

    // Silence would be wrong: both balance sheet lines moved, and the P&L
    // should show both sides rather than a net of nothing.
    const entry = result.entry as JournalEntry;
    expect(entry.postings).toHaveLength(4);
    expect(entry.amountFor("4400").toString()).toBe("-20.00 GBP");
    expect(entry.amountFor("5950").toString()).toBe("20.00 GBP");
    expect(entry.amountFor("2101").toString()).toBe("-20.00 GBP");
  });

  it("takes a different pair of gain and loss accounts", () => {
    const result = revalue(books(), {
      asAt: "2026-03-31",
      rates: RATES,
      gainAccount: "4300",
      lossAccount: "5800",
    });
    expect((result.entry as JournalEntry).amountFor("4300").toString()).toBe("-25.00 GBP");
  });

  it("refuses a gain account the chart cannot post to", () => {
    expect(() =>
      revalue(books(), { asAt: "2026-03-31", rates: RATES, gainAccount: "4000" }),
    ).toThrow(RevaluationError);
  });

  it("can be pointed at some accounts and told to leave others alone", () => {
    const only = revalue(books(), { asAt: "2026-03-31", rates: RATES, accounts: ["1131"] });
    expect(only.net.toString()).toBe("20.00 GBP");
    const without = revalue(books(), { asAt: "2026-03-31", rates: RATES, exclude: ["2101"] });
    expect(without.net.toString()).toBe("20.00 GBP");
  });

  it("says so rather than guessing when it has no rate", () => {
    expect(() => revalue(books(), { asAt: "2026-12-31", rates: RATES })).toThrow(
      /No EUR\/GBP rate available/,
    );
  });

  it("reports nothing to revalue when nothing is exposed", () => {
    const sterlingOnly = Ledger.from(
      [
        JournalEntry.simple(
          {
            id: "JE-1",
            date: "2026-01-01",
            narration: "Rent",
            debit: "5300",
            credit: "1110",
            amount: Money.parse("100.00", GBP),
          },
          CHART,
        ),
      ],
      CHART,
    );
    const result = revalue(sterlingOnly, { asAt: "2026-03-31", rates: RATES });
    expect(result.lines).toHaveLength(0);
    expect(result.entry).toBeNull();
    expect(renderRevaluation(result)).toContain("No foreign-currency balances to revalue");
  });

  it("renders what it did, with the rates it used", () => {
    const text = renderRevaluation(revalue(books(), { asAt: "2026-03-31", rates: RATES }));
    expect(text).toContain("Revaluation at 2026-03-31 (books kept in GBP)");
    expect(text).toContain("Net unrealised gain of 25.00 GBP");
    expect(text).toContain("EUR/GBP 0.860000");
    expect(text).toContain("USD/GBP 0.770000");
  });

  it("says when there is nothing to post", () => {
    const once = applyRevaluation(books(), { asAt: "2026-03-31", rates: RATES });
    const text = renderRevaluation(revalue(once, { asAt: "2026-03-31", rates: RATES }));
    expect(text).toContain("already carried at the closing rate");
  });

  it("carries the provenance of the rate it used", () => {
    // 2 April is a Thursday with no quote; the 31 March close is what stands.
    const result = revalue(books(), { asAt: "2026-04-02", rates: RATES });
    const line = result.lines[0] as RevaluationLine;
    expect(line.lookup.staleDays).toBe(2);
    expect(line.lookup.direct).toBe(true);
  });

  it("prices through a triangulation when that is all there is", () => {
    const viaEuro = RateTable.of([
      { date: "2026-03-31", base: "EUR", quote: "GBP", rate: "0.8600" },
      { date: "2026-03-31", base: "EUR", quote: "USD", rate: "1.1169" },
    ]);
    const result = revalue(books(), { asAt: "2026-03-31", rates: viaEuro, accounts: ["2101"] });
    const line = result.lines[0] as RevaluationLine;
    expect(line.lookup.via).toEqual(["USD", "EUR", "GBP"]);
    // 0.8600 / 1.1169 is 0.769988..., not the 0.7700 quoted directly, and the
    // composed rate is what gets applied: 500 USD comes to 384.99 rather than
    // 385.00. A leg-by-leg conversion would have rounded to 447.67 EUR first
    // and landed somewhere else again.
    expect(line.closingRate.toDecimalString(6)).toBe("0.769988");
    expect(line.closingAmount.toString()).toBe("-384.99 GBP");
  });
});

describe("a currency the trial balance has never seen", () => {
  it("shows up as an exposure the moment it is posted", () => {
    const chart = ChartOfAccounts.build(
      [
        ...STANDARD_ACCOUNTS,
        { code: "1132", name: "Receivable (USD)", type: "asset", parent: "1100", currency: "USD" },
      ],
      { currency: "GBP" },
    );
    const ledger = Ledger.from(
      [
        JournalEntry.create({
          id: "INV-1",
          date: "2026-01-20",
          narration: "Invoice",
          postings: [
            { account: "1132", amount: Money.parse("78.00", GBP), foreign: Money.parse("100.00", USD) },
            { account: "4200", amount: Money.parse("-78.00", GBP) },
          ],
        }),
      ],
      chart,
    );
    const list = exposures(ledger);
    expect(list).toHaveLength(1);
    expect((list[0] as Exposure).currency.code).toBe("USD");
  });
});
