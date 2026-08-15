import { describe, expect, it } from "vitest";
import { date, dateRange } from "../src/ledger/index.js";
import { trialBalance } from "../src/ledger/index.js";
import { incomeStatement } from "../src/reports/incomeStatement.js";
import { balanceSheet } from "../src/reports/balanceSheet.js";
import { ageing } from "../src/reports/ageing.js";
import { statementsReport } from "../src/demo/statements.js";
import { receivablesLedger } from "../src/demo/receivables.js";

const ledger = receivablesLedger();
const asAt = date("2026-09-30");
const quarter = dateRange("2026-07-01", "2026-09-30");

describe("the receivables quarter", () => {
  it("has seven invoices and five receipts on top of the opening balance", () => {
    expect(ledger.size).toBe(1 + 7 + 5 + 7);
    expect(trialBalance(ledger, { asAt }).balanced).toBe(true);
  });

  it("earned £8,700 in the quarter against £7,511.65 of costs", () => {
    const statement = incomeStatement(ledger, quarter, {
      comparative: dateRange("2026-04-01", "2026-06-30"),
    });
    expect(statement.income.total.toDecimalString()).toBe("8700.00");
    expect(statement.expenses.total.toDecimalString()).toBe("7511.65");
    expect(statement.netResult.toDecimalString()).toBe("1188.35");
    expect(statement.comparativeNetResult?.toDecimalString()).toBe("3650.00");
  });

  it("shows £7,260 of debtors, which is what the ageing report totals to", () => {
    const sheet = balanceSheet(ledger, asAt);
    const debtors = sheet.assets.rows.find((row) => row.account === "1130");
    expect(debtors?.amount.toDecimalString()).toBe("7260.00");
    expect(ageing(ledger, "1130", asAt).total.toDecimalString()).toBe("7260.00");
  });

  it("carries £2,800 of that in the oldest bucket", () => {
    const buckets = ageing(ledger, "1130", asAt).buckets;
    expect(buckets.at(-1)?.label).toBe("91+");
    expect(buckets.at(-1)?.total.toDecimalString()).toBe("2800.00");
    expect(buckets.at(-1)?.items.map((i) => i.reference)).toEqual(["INV-2001"]);
  });

  it("ties VAT payable to the invoices raised", () => {
    // 20% of every invoice, none of it paid over yet.
    const sheet = balanceSheet(ledger, asAt);
    expect(sheet.liabilities.rows.find((r) => r.account === "2200")?.amount.toDecimalString()).toBe(
      "2840.00",
    );
  });
});

describe("the statements report", () => {
  const text = statementsReport();

  it("prints all four statements", () => {
    expect(text).toContain("Income statement (GBP)  2026-07-01 to 2026-09-30");
    expect(text).toContain("Balance sheet (GBP) as at 2026-09-30");
    expect(text).toContain("Ageing — 1130 Accounts Receivable");
    expect(text).toContain("Trial balance as at 2026-09-30");
  });

  it("balances everywhere it claims to", () => {
    expect(text).toContain("Balanced");
    expect(text).not.toContain("OUT OF BALANCE");
  });

  it("shows the comparative columns filled in, not blank", () => {
    expect(text).toContain("period        prior     movement");
    expect(text).toContain("Profit for the period                   1188.35      3650.00");
  });

  it("is stable across runs", () => {
    expect(statementsReport()).toBe(text);
  });
});
