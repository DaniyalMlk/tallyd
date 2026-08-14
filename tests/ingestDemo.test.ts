import { describe, expect, it } from "vitest";
import { DEMO_BANK_CSV, DEMO_BANK_OFX } from "../src/demo/statement.js";
import { ingestReport } from "../src/demo/ingest.js";
import { importCsv } from "../src/statement/import.js";
import { importOfx } from "../src/statement/ofx.js";
import { importStatement } from "../src/statement/index.js";
import { findNearDuplicates } from "../src/statement/duplicates.js";
import { GBP, sumMoney } from "../src/money/index.js";

const csv = importCsv(DEMO_BANK_CSV, { currency: GBP, idPrefix: "BANK" });
const ofx = importOfx(DEMO_BANK_OFX);

describe("the demo bank statement", () => {
  it("imports every row cleanly", () => {
    expect(csv.rowsRead).toBe(12);
    expect(csv.lines).toHaveLength(12);
    expect(csv.errors).toEqual([]);
  });

  it("finds the paid out / paid in pair through the preamble", () => {
    expect(csv.mapping.debit).toBe(2);
    expect(csv.mapping.credit).toBe(3);
    expect(csv.dateFormat).toBe("DD/MM/YYYY");
  });

  it("agrees with the bank's own closing balance", () => {
    // Every movement, summed, must land on the balance the last row states.
    const total = sumMoney(
      csv.lines.map((l) => l.amount),
      GBP,
    );
    expect(total.toDecimalString()).toBe("20764.20");
    expect(csv.lines[csv.lines.length - 1]?.balance?.toDecimalString()).toBe("20764.20");
  });

  it("carries a running balance consistent with each movement", () => {
    for (let i = 1; i < csv.lines.length; i++) {
      const previous = csv.lines[i - 1]?.balance;
      const current = csv.lines[i];
      if (previous === undefined || previous === null || current?.balance == null) continue;
      expect(previous.plus(current.amount).equals(current.balance)).toBe(true);
    }
  });

  it("spots the two identical bistro charges a day apart", () => {
    const near = findNearDuplicates(csv.lines);
    expect(near).toHaveLength(1);
    expect(near[0]?.daysApart).toBe(1);
    expect(near[0]?.a.amount.toDecimalString()).toBe("-142.50");
  });

  it("does not flag them as exact duplicates, because they are not", () => {
    // Same amount and merchant, different dates: a human decides, not the tool.
    expect(csv.duplicates).toEqual([]);
  });

  it("contains transactions the ledger has never seen", () => {
    const descriptions = csv.lines.map((l) => l.normalisedDescription);
    expect(descriptions).toContain("CASH WITHDRAWAL");
    expect(descriptions).toContain("INTEREST PAID");
  });
});

describe("the same account as OFX", () => {
  it("reads the download", () => {
    expect(ofx.lines).toHaveLength(6);
    expect(ofx.errors).toEqual([]);
    expect(ofx.account.accountId).toBe("12345678");
    expect(ofx.ledgerBalance?.toDecimalString()).toBe("20764.20");
  });

  it("produces the same normalised descriptions as the CSV path", () => {
    const fromCsv = csv.lines.find((l) => l.description.includes("SETTLEMENT"));
    const fromOfx = ofx.lines.find((l) => l.description.includes("SETTLEMENT"));
    expect(fromOfx?.normalisedDescription).toBe(fromCsv?.normalisedDescription);
  });

  it("agrees with the CSV on the rows they share", () => {
    for (const line of ofx.lines) {
      const match = csv.lines.find(
        (c) => c.date === line.date && c.amount.equals(line.amount),
      );
      expect(match, `no CSV row for ${line.date} ${line.amount.toDecimalString()}`).toBeDefined();
    }
  });
});

describe("format sniffing", () => {
  it("routes CSV and OFX to the right reader", () => {
    expect(importStatement(DEMO_BANK_CSV, { currency: GBP }).format).toBe("csv");
    expect(importStatement(DEMO_BANK_OFX, { currency: GBP }).format).toBe("ofx");
  });

  it("produces lines either way", () => {
    expect(importStatement(DEMO_BANK_CSV, { currency: GBP }).lines).toHaveLength(12);
    expect(importStatement(DEMO_BANK_OFX, { currency: GBP }).lines).toHaveLength(6);
  });
});

describe("the ingest report", () => {
  const text = ingestReport();

  it("shows the import summary and the mapping", () => {
    expect(text).toContain("12 lines, 0 duplicates, 0 errors");
    expect(text).toContain("2:debit");
  });

  it("surfaces the near-duplicate pair", () => {
    expect(text).toContain("Near-duplicates worth a second look");
    expect(text).toContain("1d apart");
  });

  it("shows normalised descriptions", () => {
    expect(text).toContain("Descriptions as the matcher will see them");
    expect(text).toContain("SETTLEMENT");
  });
});
