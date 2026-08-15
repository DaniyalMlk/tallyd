import { describe, expect, it } from "vitest";
import { GBP, Money } from "../src/money/index.js";
import { JournalEntry, Ledger, date, dateRange } from "../src/ledger/index.js";
import { standardChart } from "../src/accounts/index.js";
import {
  incomeStatement,
  netResultFor,
  renderIncomeStatement,
} from "../src/reports/incomeStatement.js";
import { balanceSheet, renderBalanceSheet } from "../src/reports/balanceSheet.js";
import { movementsIn } from "../src/reports/period.js";
import { demoLedger } from "../src/demo/month.js";
import { receivablesLedger } from "../src/demo/receivables.js";

const gbp = (text: string) => Money.parse(text, GBP);
const chart = standardChart(GBP);

function small(): Ledger {
  return Ledger.empty(chart)
    .post(
      JournalEntry.simple({
        id: "A",
        date: "2026-07-05",
        narration: "July fees",
        debit: "1130",
        credit: "4200",
        amount: gbp("1000.00"),
      }),
    )
    .post(
      JournalEntry.simple({
        id: "B",
        date: "2026-07-20",
        narration: "July rent",
        debit: "5300",
        credit: "1110",
        amount: gbp("400.00"),
      }),
    )
    .post(
      JournalEntry.simple({
        id: "C",
        date: "2026-08-05",
        narration: "August fees",
        debit: "1130",
        credit: "4200",
        amount: gbp("1500.00"),
      }),
    )
    .post(
      JournalEntry.simple({
        id: "D",
        date: "2026-08-20",
        narration: "August rent",
        debit: "5300",
        credit: "1110",
        amount: gbp("400.00"),
      }),
    );
}

describe("movementsIn", () => {
  it("counts only what happened inside the range", () => {
    const july = movementsIn(small(), dateRange("2026-07-01", "2026-07-31"), "GBP");
    expect(july.map((m) => m.account)).toEqual(["1110", "1130", "4200", "5300"]);
    expect(july.find((m) => m.account === "4200")?.credit.toDecimalString()).toBe("1000.00");
  });

  it("is inclusive at both ends of the range", () => {
    const exact = movementsIn(small(), dateRange("2026-07-05", "2026-07-20"), "GBP");
    expect(exact.find((m) => m.account === "4200")?.credit.toDecimalString()).toBe("1000.00");
    expect(exact.find((m) => m.account === "5300")?.debit.toDecimalString()).toBe("400.00");

    const narrower = movementsIn(small(), dateRange("2026-07-06", "2026-07-19"), "GBP");
    expect(narrower).toEqual([]);
  });

  it("returns nothing for a range with no activity", () => {
    expect(movementsIn(small(), dateRange("2026-01-01", "2026-01-31"), "GBP")).toEqual([]);
  });
});

describe("incomeStatement", () => {
  const july = dateRange("2026-07-01", "2026-07-31");
  const august = dateRange("2026-08-01", "2026-08-31");

  it("reports income and expenses as positive magnitudes", () => {
    const statement = incomeStatement(small(), july);
    expect(statement.income.rows.map((r) => [r.account, r.amount.toDecimalString()])).toEqual([
      ["4200", "1000.00"],
    ]);
    expect(statement.expenses.rows.map((r) => [r.account, r.amount.toDecimalString()])).toEqual([
      ["5300", "400.00"],
    ]);
  });

  it("computes the net result as income less expenses", () => {
    expect(incomeStatement(small(), july).netResult.toDecimalString()).toBe("600.00");
    expect(incomeStatement(small(), august).netResult.toDecimalString()).toBe("1100.00");
  });

  it("reports a loss as a negative result", () => {
    const lossy = small().post(
      JournalEntry.simple({
        id: "E",
        date: "2026-07-25",
        narration: "Legal fees",
        debit: "5700",
        credit: "1110",
        amount: gbp("2000.00"),
      }),
    );
    const statement = incomeStatement(lossy, july);
    expect(statement.netResult.toDecimalString()).toBe("-1400.00");
    expect(renderIncomeStatement(statement)).toContain("Loss for the period");
  });

  it("carries a comparative period on every line and total", () => {
    const statement = incomeStatement(small(), august, { comparative: july });
    const consulting = statement.income.rows.find((r) => r.account === "4200");
    expect(consulting?.amount.toDecimalString()).toBe("1500.00");
    expect(consulting?.comparative?.toDecimalString()).toBe("1000.00");
    expect(consulting?.movement?.toDecimalString()).toBe("500.00");
    expect(statement.comparativeNetResult?.toDecimalString()).toBe("600.00");
  });

  it("shows a zero rather than a blank when an account moved in only one period", () => {
    const withNewCost = small().post(
      JournalEntry.simple({
        id: "E",
        date: "2026-08-25",
        narration: "Software",
        debit: "5400",
        credit: "1110",
        amount: gbp("99.00"),
      }),
    );
    const statement = incomeStatement(withNewCost, august, { comparative: july });
    const software = statement.expenses.rows.find((r) => r.account === "5400");
    expect(software?.comparative?.toDecimalString()).toBe("0.00");
    expect(software?.movement?.toDecimalString()).toBe("99.00");
    // The column still adds up, which is the point of not leaving it blank.
    const columnTotal = statement.expenses.rows.reduce(
      (sum, row) => sum + (row.comparative?.minorUnits ?? 0n),
      0n,
    );
    expect(columnTotal).toBe(statement.expenses.comparativeTotal?.minorUnits);
  });

  it("leaves the comparative fields null when no comparative was asked for", () => {
    const statement = incomeStatement(small(), july);
    expect(statement.comparativePeriod).toBeNull();
    expect(statement.comparativeNetResult).toBeNull();
    expect(statement.income.rows.every((r) => r.comparative === null)).toBe(true);
  });

  it("is empty for a period with no trading", () => {
    const statement = incomeStatement(small(), dateRange("2026-01-01", "2026-01-31"));
    expect(statement.income.rows).toEqual([]);
    expect(statement.expenses.rows).toEqual([]);
    expect(statement.netResult.isZero).toBe(true);
  });

  it("agrees with netResultFor", () => {
    for (const period of [july, august, dateRange("2026-07-01", "2026-08-31")]) {
      expect(netResultFor(small(), period).minorUnits).toBe(
        incomeStatement(small(), period).netResult.minorUnits,
      );
    }
  });

  it("matches the worked month's own figures", () => {
    const statement = incomeStatement(demoLedger(), dateRange("2026-08-01", "2026-08-31"));
    expect(statement.income.total.toDecimalString()).toBe("6480.00");
    expect(statement.expenses.total.toDecimalString()).toBe("11716.42");
    expect(statement.netResult.toDecimalString()).toBe("-5236.42");
  });
});

describe("balanceSheet", () => {
  it("balances on the worked month", () => {
    const sheet = balanceSheet(demoLedger(), date("2026-08-31"));
    expect(sheet.balanced).toBe(true);
    expect(sheet.difference.isZero).toBe(true);
    expect(sheet.assets.total.toDecimalString()).toBe("23143.58");
  });

  it("balances on the receivables quarter", () => {
    const sheet = balanceSheet(receivablesLedger(), date("2026-09-30"));
    expect(sheet.balanced).toBe(true);
    expect(sheet.assets.total.toDecimalString()).toBe("19678.35");
    expect(sheet.liabilities.total.toDecimalString()).toBe("2840.00");
    expect(sheet.equity.total.toDecimalString()).toBe("16838.35");
  });

  it("folds the period result into equity as its own visible line", () => {
    const sheet = balanceSheet(small(), date("2026-08-31"));
    const synthetic = sheet.equity.rows.filter((row) => row.synthetic);
    expect(synthetic).toHaveLength(1);
    expect(synthetic[0]?.amount.toDecimalString()).toBe("1700.00");
    expect(sheet.resultForPeriod.toDecimalString()).toBe("1700.00");
  });

  it("would not balance without that fold, which is why it is there", () => {
    const sheet = balanceSheet(small(), date("2026-08-31"));
    const bookedEquityOnly = sheet.equity.total.minus(sheet.resultForPeriod);
    expect(sheet.assets.total.minus(sheet.liabilities.total.plus(bookedEquityOnly)).isZero).toBe(
      false,
    );
    expect(sheet.balanced).toBe(true);
  });

  it("names the fold a loss when the business lost money", () => {
    const sheet = balanceSheet(demoLedger(), date("2026-08-31"));
    expect(sheet.resultForPeriod.isNegative).toBe(true);
    expect(renderBalanceSheet(sheet)).toContain("Loss for the period");
  });

  it("moves with the as-at date", () => {
    const early = balanceSheet(small(), date("2026-07-31"));
    const late = balanceSheet(small(), date("2026-08-31"));
    expect(early.resultForPeriod.toDecimalString()).toBe("600.00");
    expect(late.resultForPeriod.toDecimalString()).toBe("1700.00");
    expect(early.balanced && late.balanced).toBe(true);
  });

  it("balances on an empty ledger", () => {
    const sheet = balanceSheet(Ledger.empty(chart), date("2026-08-31"));
    expect(sheet.balanced).toBe(true);
    expect(sheet.assets.rows).toEqual([]);
    expect(sheet.equity.rows).toHaveLength(1); // the zero result line
  });

  it("balances at every date across both worked examples", () => {
    for (const build of [demoLedger, receivablesLedger]) {
      const ledger = build();
      for (const entry of ledger.chronological()) {
        expect(balanceSheet(ledger, entry.date).balanced).toBe(true);
      }
      expect(balanceSheet(ledger, date("2026-12-31")).balanced).toBe(true);
      expect(balanceSheet(ledger, date("2020-01-01")).balanced).toBe(true);
    }
  });

  it("ties the period result to the income statement over the same span", () => {
    const ledger = receivablesLedger();
    const asAt = date("2026-09-30");
    const sheet = balanceSheet(ledger, asAt);
    const statement = incomeStatement(ledger, dateRange("2026-06-01", "2026-09-30"));
    expect(sheet.resultForPeriod.minorUnits).toBe(statement.netResult.minorUnits);
  });
});
