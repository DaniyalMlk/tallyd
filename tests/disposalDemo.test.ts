import { describe, expect, it } from "vitest";
import { GBP } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { balanceSheet } from "../src/reports/balanceSheet.js";
import { incomeStatement } from "../src/reports/incomeStatement.js";
import { netAssets } from "../src/group/acquisition.js";
import {
  consolidateDisposal,
  disposalPeriod,
  disposalReport,
  disposalStructure,
  pellewLedger,
} from "../src/demo/disposal.js";

const gbp = (text: string) => Money.parse(text, GBP);

describe("the company's own books, before anybody consolidates them", () => {
  const books = pellewLedger();

  it("had 350,000 of net assets on the day it was bought", () => {
    expect(netAssets(books, "2024-12-31" as never, GBP)).toEqual(gbp("350000.00"));
  });

  it("had 400,000 when the reporting period opened", () => {
    expect(netAssets(books, "2025-12-31" as never, GBP)).toEqual(gbp("400000.00"));
  });

  it("had 500,000 on the day it was sold", () => {
    expect(netAssets(books, "2026-09-30" as never, GBP)).toEqual(gbp("500000.00"));
  });

  it("kept trading afterwards, which is the point of the fixture", () => {
    expect(netAssets(books, "2026-12-31" as never, GBP)).toEqual(gbp("590000.00"));
  });
});

describe("the consolidated statements", () => {
  const result = consolidateDisposal();

  it("reports a profit made of the holder's trading, eight months, and the gain", () => {
    const statement = incomeStatement(result.ledger, disposalPeriod(), { currency: GBP });
    expect(statement.netResult).toEqual(gbp("260000.00"));
  });

  it("balances the balance sheet", () => {
    const sheet = balanceSheet(result.ledger, result.asAt, { currency: GBP });
    expect(sheet.balanced).toBe(true);
    expect(sheet.assets.total).toEqual(gbp("1430000.00"));
  });

  it("keeps the group's reserves brought forward at the group's share", () => {
    // 150,000 the holder earned in 2025, plus 80% of the 50,000 Pellew earned
    // between the purchase and the start of this period.
    expect(result.ledger.balanceOf("3200", GBP)).toEqual(gbp("-190000.00"));
  });

  it("leaves the group's structure saying the company has gone", () => {
    expect(disposalStructure().disposedEntities().map((e) => e.code)).toEqual(["PM"]);
  });
});

describe("the report", () => {
  const text = disposalReport();

  it("shows both answers side by side", () => {
    expect(text).toContain("The holder's own gain");
    expect(text).toContain("The group's gain");
  });

  it("explains the difference in the terms it is made of", () => {
    expect(text).toContain("The difference is 120000.00");
    expect(text).toContain("reporting it twice");
  });

  it("shows the window closing in September", () => {
    expect(text).toContain("2026-01-01 to 2026-09-30");
  });

  it("prints statements that balance", () => {
    expect(text).toContain("Income statement");
    expect(text).toContain("Balance sheet");
    expect(text).toContain("Accounting equation residual");
  });

  it("says nothing of the company survives in the balance sheet", () => {
    expect(text).toContain("Nothing of Pellew Marine survives");
  });
});
