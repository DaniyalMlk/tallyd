import { describe, expect, it } from "vitest";
import { foreignChart, foreignLedger, foreignRates } from "../src/demo/foreign.js";
import { foreignReport } from "../src/demo/foreignReport.js";
import { trialBalance, equationResidual } from "../src/ledger/trialBalance.js";
import { GBP } from "../src/money/currency.js";
import { openItems } from "../src/fx/exposure.js";

describe("the worked quarter", () => {
  it("posts three transactions across two currencies", () => {
    const ledger = foreignLedger();
    expect(ledger.size).toBe(3);
    expect(openItems(ledger).map((i) => i.reference)).toEqual([
      "INV-014",
      "INV-021",
      "BILL-221",
    ]);
  });

  it("balances and satisfies the accounting equation before anything is revalued", () => {
    const ledger = foreignLedger();
    expect(trialBalance(ledger, { currency: GBP }).balanced).toBe(true);
    expect(equationResidual(ledger, { currency: GBP }).isZero).toBe(true);
  });

  it("prices every date the story needs", () => {
    const rates = foreignRates();
    for (const day of ["2026-01-20", "2026-02-15", "2026-03-31", "2026-04-20"]) {
      expect(rates.has("EUR", "GBP", day)).toBe(true);
      expect(rates.has("USD", "GBP", day)).toBe(true);
    }
  });

  it("keeps the two foreign accounts denominated where they should be", () => {
    const chart = foreignChart();
    expect(chart.get("1131").currency.code).toBe("EUR");
    expect(chart.get("2101").currency.code).toBe("USD");
    expect(chart.defaultCurrency.code).toBe("GBP");
  });
});

describe("the report the demo prints", () => {
  const report = foreignReport();

  it("shows each open item retranslated on its own line", () => {
    expect(report).toContain("Accounts Receivable (EUR) / INV-014       1000.00 EUR");
    expect(report).toContain("Accounts Receivable (EUR) / INV-021        500.00 EUR");
    expect(report).toContain("Accounts Payable (USD) / BILL-221         -500.00 USD");
  });

  it("books 30.00 as unrealised at the close", () => {
    expect(report).toContain("Net unrealised gain of 30.00 GBP");
  });

  it("realises only what happened after the close", () => {
    expect(report).toContain("carried at   430.00  received   435.00  realised    5.00");
    expect(report).toContain("carried at  -385.00  paid      -380.00  realised    5.00");
  });

  it("counts the whole rate movement exactly once", () => {
    expect(report).toContain("Counted once: the unrealised and realised halves add up.");
    expect(report).not.toContain("MISMATCH");
  });

  it("leaves the unsettled invoice carried at the closing rate", () => {
    expect(report).toContain("1000.00 EUR        860.00    0.860000");
  });

  it("ends on a trial balance that agrees", () => {
    expect(report).toContain("Total                           1305.00     1305.00");
    expect(report).not.toContain("OUT BY");
  });
});
