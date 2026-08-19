import { describe, expect, it } from "vitest";
import { GBP } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { balanceSheet } from "../src/reports/balanceSheet.js";
import { incomeStatement } from "../src/reports/incomeStatement.js";
import { ledgerFromJson, ledgerToJson } from "../src/ledger/serialise.js";
import { GROUP_ACCOUNTS } from "../src/group/accounts.js";
import { groupLedgers, groupStructure } from "../src/demo/group.js";
import { consolidatedGroup, groupReport } from "../src/demo/groupReport.js";

describe("the worked group", () => {
  it("has an interest in the third company that neither link gives on its own", () => {
    const group = groupStructure();
    expect(group.effectiveInterest("HN").toPercentString()).toBe("80%");
    expect(group.effectiveInterest("HS").toPercentString()).toBe("60%");
    expect(group.nonControllingInterest("HS").toPercentString()).toBe("40%");
  });

  it("keeps each company's books in its own currency and balanced", () => {
    for (const [code, ledger] of Object.entries(groupLedgers())) {
      ledger.verify();
      expect(ledger.isBalanced, code).toBe(true);
    }
  });

  it("consolidates to a ledger that agrees with itself", () => {
    const result = consolidatedGroup();
    result.ledger.verify();
    expect(result.balanced).toBe(true);
    expect(result.residual.isZero).toBe(true);
  });

  it("eliminates both investments down to nothing", () => {
    const result = consolidatedGroup();
    expect(result.investmentResidual.isZero).toBe(true);
    expect(result.ledger.balanceOf(GROUP_ACCOUNTS.investment, GBP).isZero).toBe(true);
  });

  it("splits the equity between the group and the outside stakes without a gap", () => {
    const result = consolidatedGroup();
    const sheet = balanceSheet(result.ledger, result.asAt, { currency: GBP });
    const outside = result.workings.reduce(
      (running, working) => running.plus(working.nciClosing),
      Money.zero(GBP),
    );
    expect(outside.equals(result.nonControllingInterest)).toBe(true);
    expect(sheet.balanced).toBe(true);
    expect(sheet.assets.total.equals(sheet.totalLiabilitiesAndEquity)).toBe(true);
  });

  it("leaves no intercompany balance in the consolidated books", () => {
    const result = consolidatedGroup();
    expect(result.ledger.balanceOf(GROUP_ACCOUNTS.intercompanyReceivable, GBP).isZero).toBe(true);
    expect(result.ledger.balanceOf(GROUP_ACCOUNTS.intercompanyPayable, GBP).isZero).toBe(true);
    expect(result.ledger.balanceOf(GROUP_ACCOUNTS.intercompanySales, GBP).isZero).toBe(true);
    expect(result.ledger.balanceOf(GROUP_ACCOUNTS.intercompanyPurchases, GBP).isZero).toBe(true);
  });

  it("carries the repayment in transit rather than making it disappear", () => {
    const result = consolidatedGroup();
    // The German company repaid 60,000 EUR on 28 December and the parent has
    // not recorded it, so the two intercompany accounts disagree.
    expect(result.eliminations.disagreements).toHaveLength(2);
    expect(result.ledger.balanceOf(GROUP_ACCOUNTS.itemsInTransit, GBP).isPositive).toBe(true);
    expect(
      result.ledger
        .balanceOf(GROUP_ACCOUNTS.itemsInTransit, GBP)
        .equals(result.eliminations.totalDifference),
    ).toBe(true);
  });

  it("keeps consolidated revenue free of what the group sold to itself", () => {
    const result = consolidatedGroup();
    const statement = incomeStatement(result.ledger, result.period, { currency: GBP });
    const codes = statement.income.rows.map((row) => row.account);
    expect(codes).not.toContain(GROUP_ACCOUNTS.intercompanySales);
    expect(statement.income.total.isPositive).toBe(true);
  });

  it("attributes part of the result to the outside stakes", () => {
    const result = consolidatedGroup();
    const allocated = result.workings.reduce(
      (running, working) => running.plus(working.nciProfitShare),
      Money.zero(GBP),
    );
    expect(allocated.isPositive).toBe(true);
    expect(result.ledger.balanceOf(GROUP_ACCOUNTS.nciProfitShare, GBP).equals(allocated)).toBe(true);
  });

  it("writes out as a document and reads back the same", () => {
    const result = consolidatedGroup();
    const reloaded = ledgerFromJson(ledgerToJson(result.ledger));
    reloaded.verify();
    expect(reloaded.size).toBe(result.ledger.size);
    expect(
      reloaded.balanceOf(GROUP_ACCOUNTS.nonControllingInterest, GBP).negated().toDecimalString(),
    ).toBe(result.nonControllingInterest.toDecimalString());
  });

  it("is reproducible: the same books consolidate to the same figures twice", () => {
    expect(ledgerToJson(consolidatedGroup().ledger)).toBe(ledgerToJson(consolidatedGroup().ledger));
  });

  it("prints a report that ends by agreeing with itself", () => {
    const text = groupReport();
    expect(text).toContain("A group of three companies in three currencies");
    expect(text).toContain("The workings and the ledger agree on what belongs to whom.");
    expect(text).not.toContain("THE WORKINGS AND THE LEDGER DISAGREE");
    expect(text).not.toContain("DOES NOT BALANCE");
  });
});
