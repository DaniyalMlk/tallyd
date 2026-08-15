import { describe, expect, it } from "vitest";
import { GBP, Money } from "../src/money/index.js";
import { monthScenario, supplierRunScenario, reconcileReport } from "../src/demo/reconcile.js";
import {
  reconciliationBridge,
  statementClosingBalance,
} from "../src/reconcile/bridge.js";
import { SUPPLIER_RUN_TOTAL, CUSTOMER_RECEIPT_TOTAL } from "../src/demo/supplierRun.js";
import { bankView } from "../src/reconcile/bankView.js";
import { demoLedger } from "../src/demo/month.js";

function bridgeFor(scenario: ReturnType<typeof monthScenario>) {
  const ledgerBalance = scenario.books.reduce(
    (total, line) => total.plus(line.amount),
    Money.zero(GBP),
  );
  return reconciliationBridge(scenario.result, {
    bankClosingBalance: statementClosingBalance(scenario.statement, Money.zero(GBP)),
    bookClosingBalance: ledgerBalance,
  });
}

describe("the worked month, reconciled", () => {
  const scenario = monthScenario();
  const { result } = scenario;

  it("reads 10 ledger movements against 12 statement lines", () => {
    expect(scenario.books).toHaveLength(10);
    expect(scenario.statement).toHaveLength(12);
  });

  it("matches seven of them outright", () => {
    expect(result.matched).toHaveLength(7);
    expect(result.matched.every((match) => match.kind === "one-to-one")).toBe(true);
    expect(result.matched.map((match) => match.statement[0]?.description)).toEqual([
      "BGC SHARE CAPITAL",
      "DD RENT, AUGUST 08",
      "SQ *SETTLEMENT 0805 4471",
      "TOOLCHAIN LTD SUB9931",
      "FPI ACME LTD INV1001",
      "PAYROLL AUGUST",
      "BANK CHARGES",
    ]);
  });

  it("pairs the late card settlement despite the fee and the two-day lag", () => {
    const settlement = result.matched.find(
      (match) => match.statement[0]?.description === "SQ *SETTLEMENT 0805 4471",
    );
    expect(settlement?.book[0]?.entryId).toBe("JE-005");
    expect(settlement?.statement[0]?.amount.toDecimalString()).toBe("473.08");
    expect(settlement?.scored.confidence).toBe("exact");
  });

  it("connects the invoice to the receipt through the reference alone", () => {
    const invoice = result.matched.find(
      (match) => match.statement[0]?.description === "FPI ACME LTD INV1001",
    );
    expect(invoice?.scored.reasons.find((r) => r.rule === "reference")?.detail).toContain("1001");
    expect(invoice?.scored.score).toBeGreaterThanOrEqual(0.95);
  });

  it("sends both bistro payments to review rather than guessing", () => {
    expect(result.suggested).toHaveLength(2);
    expect(
      result.suggested.every((match) => match.statement[0]?.description.includes("BISTRO")),
    ).toBe(true);
    expect(result.suggested.every((match) => match.scored.confidence === "medium")).toBe(true);
  });

  it("leaves exactly the items the books never knew about", () => {
    expect(result.unmatchedStatement.map((line) => line.description)).toEqual([
      "ATM CASH WITHDRAWAL 200000",
      "HMRC PAYE NI",
      "INTEREST PAID",
    ]);
    expect(result.unmatchedBook.map((line) => line.entryId)).toEqual(["JE-009"]);
  });

  it("bridges the bank's closing balance to the ledger's, exactly", () => {
    const bridge = bridgeFor(scenario);
    expect(bridge.bankClosingBalance.toDecimalString()).toBe("20764.20");
    expect(bridge.bookClosingBalance.toDecimalString()).toBe("23143.58");
    expect(bridge.adjustedBankBalance.toDecimalString()).toBe("20621.70");
    expect(bridge.adjustedBookBalance.toDecimalString()).toBe("20621.70");
    expect(bridge.reconciled).toBe(true);
  });

  it("agrees with the ledger's own balance for the bank account", () => {
    expect(bridgeFor(scenario).bookClosingBalance.minorUnits).toBe(
      demoLedger().balanceOf("1110").minorUnits,
    );
    expect(bankView(demoLedger(), "1110")).toHaveLength(10);
  });
});

describe("batch payments and a lump-sum receipt", () => {
  const scenario = supplierRunScenario();
  const { result } = scenario;

  it("adds up the way the example says it does", () => {
    expect(SUPPLIER_RUN_TOTAL.toDecimalString()).toBe("2138.00");
    expect(CUSTOMER_RECEIPT_TOTAL.toDecimalString()).toBe("5160.00");
  });

  it("matches the lump-sum receipt against the three invoices it settles", () => {
    const group = result.matched.find((match) => match.kind === "one-to-many");
    expect(group?.book.map((line) => line.entryId)).toEqual(["REC-01", "REC-02", "REC-03"]);
    expect(group?.statement).toHaveLength(1);
    expect(group?.statement[0]?.amount.toDecimalString()).toBe("5160.00");
    expect(group?.scored.amountGap).toBe(0n);
  });

  it("puts the BACS run in the review queue, since only the arithmetic agrees", () => {
    const group = result.suggested.find((match) => match.kind === "one-to-many");
    expect(group?.statement[0]?.description).toBe("BACS SUPPLIER RUN 100926");
    expect(group?.book.map((line) => line.entryId)).toEqual([
      "PAY-01",
      "PAY-02",
      "PAY-03",
      "PAY-04",
    ]);
    expect(group?.scored.amountGap).toBe(0n);
    expect(group?.scored.reasons.find((r) => r.rule === "description")?.score).toBeLessThan(0.3);
  });

  it("leaves only the unbooked bank charge", () => {
    expect(result.unmatchedStatement.map((line) => line.description)).toEqual(["BANK CHARGES"]);
    expect(result.unmatchedBook).toHaveLength(0);
  });

  it("bridges exactly", () => {
    const bridge = bridgeFor(scenario);
    expect(bridge.bankClosingBalance.toDecimalString()).toBe("9150.00");
    expect(bridge.bookClosingBalance.toDecimalString()).toBe("9172.00");
    expect(bridge.adjustedBankBalance.toDecimalString()).toBe("7012.00");
    expect(bridge.reconciled).toBe(true);
  });
});

describe("the report", () => {
  const text = reconcileReport();

  it("covers both scenarios and both bridges", () => {
    expect(text).toContain("The worked month");
    expect(text).toContain("Batch payments and a lump-sum receipt");
    expect(text.match(/Reconciled/g)).toHaveLength(2);
    expect(text).not.toContain("UNRECONCILED");
  });

  it("shows the reasoning behind a match", () => {
    expect(text).toContain("· amount: exact at");
    expect(text).toContain("· reference: reference 1001");
    expect(text).toContain("Review queue");
  });

  it("is stable across runs", () => {
    expect(reconcileReport()).toBe(text);
  });
});
