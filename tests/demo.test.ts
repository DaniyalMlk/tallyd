import { describe, expect, it } from "vitest";
import { DEMO_CARD_FEE, demoLedger } from "../src/demo/month.js";
import { report } from "../src/demo/report.js";
import {
  balancesByType,
  date,
  equationResidual,
  trialBalance,
} from "../src/ledger/index.js";
import { GBP, Money, sumMoney } from "../src/money/index.js";

const ledger = demoLedger();

describe("the worked month", () => {
  it("passes its own integrity check", () => {
    expect(() => ledger.verify()).not.toThrow();
    expect(ledger.size).toBe(12);
  });

  it("produces a balanced trial balance", () => {
    const tb = trialBalance(ledger);
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit.toDecimalString()).toBe("34860.00");
    expect(equationResidual(ledger).isZero).toBe(true);
  });

  it("books the card fee as 1.4% plus 20p", () => {
    expect(DEMO_CARD_FEE.toDecimalString()).toBe("6.92");
    expect(ledger.balanceOf("5500").equals(DEMO_CARD_FEE)).toBe(true);
  });

  it("clears undeposited funds once the processor settles", () => {
    // Money sits in 1140 between capture and settlement, then leaves entirely.
    expect(ledger.balanceOf("1140").isZero).toBe(true);
    expect(ledger.balanceAsAt("1140", date("2026-08-06")).toDecimalString()).toBe("480.00");
  });

  it("splits the licence without losing a penny", () => {
    const licence = ledger.entry("JE-006");
    const software = licence?.postings.filter((p) => p.account === "5400") ?? [];
    expect(software).toHaveLength(3);
    expect(software.map((p) => p.amount.toDecimalString())).toEqual([
      "149.50",
      "89.70",
      "59.80",
    ]);
    expect(sumMoney(software.map((p) => p.amount)).toDecimalString()).toBe("299.00");
  });

  it("corrects the miscoded expense by reversal, leaving Travel at zero", () => {
    expect(ledger.balanceOf("5600").isZero).toBe(true);
    expect(ledger.balanceOf("5700").toDecimalString()).toBe("142.50");
    // The mistake is still in the history — nothing was deleted.
    expect(ledger.entry("JE-008")).toBeDefined();
    expect(ledger.entry("JE-009")?.reverses).toBe("JE-008");
  });

  it("leaves the bank where the running statement says it does", () => {
    const rows = ledger.statement("1110");
    const last = rows[rows.length - 1];
    expect(last?.running.equals(ledger.balanceOf("1110"))).toBe(true);
    expect(last?.running.toDecimalString()).toBe("23143.58");
  });

  it("keeps assets equal to liabilities plus equity plus profit", () => {
    const totals = balancesByType(ledger);
    const zero = Money.zero(GBP);
    const assets = totals.get("asset") ?? zero;
    const claims = (totals.get("liability") ?? zero)
      .plus(totals.get("equity") ?? zero)
      .plus((totals.get("income") ?? zero).minus(totals.get("expense") ?? zero));
    expect(assets.equals(claims)).toBe(true);
  });

  it("renders a report with the sections a reader expects", () => {
    const text = report();
    expect(text).toContain("Trial balance (GBP)");
    expect(text).toContain("Payment Processing Fees");
    expect(text).toContain("Bank account movements");
    expect(text).not.toContain("OUT BY");
  });
});
