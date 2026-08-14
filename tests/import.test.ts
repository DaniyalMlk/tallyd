import { describe, expect, it } from "vitest";
import { describeImport, importCsv } from "../src/statement/import.js";
import { normaliseDescription, statementLine } from "../src/statement/line.js";
import { findDuplicates, findNearDuplicates } from "../src/statement/duplicates.js";
import { GBP, Money } from "../src/money/index.js";
import { date } from "../src/ledger/index.js";

const UK_STATEMENT = [
  "Barclays Bank plc",
  "Account 12345678",
  "",
  "Date,Description,Amount,Balance",
  "01/08/2026,OPENING BALANCE,0.00,25000.00",
  '04/08/2026,"DD RENT, AUGUST",-1850.00,23150.00',
  "07/08/2026,SQ *SETTLEMENT 0805,473.08,23623.08",
  "09/08/2026,TOOLCHAIN SUB 9931,-299.00,23324.08",
  "12/08/2026,FPI ACME LTD INV1001,7200.00,30524.08",
  "31/08/2026,BANK CHARGES,-18.00,23143.58",
].join("\n");

describe("importing a UK statement", () => {
  const result = importCsv(UK_STATEMENT, { currency: GBP });

  it("skips the preamble and reads every row", () => {
    expect(result.rowsRead).toBe(6);
    expect(result.lines).toHaveLength(6);
    expect(result.errors).toEqual([]);
  });

  it("detects the format and convention", () => {
    expect(result.delimiter).toBe(",");
    expect(result.dateFormat).toBe("DD/MM/YYYY");
    expect(result.decimal).toBe("dot");
    expect(result.currency).toBe(GBP);
  });

  it("maps the columns", () => {
    expect(result.mapping.date).toBe(0);
    expect(result.mapping.description).toBe(1);
    expect(result.mapping.amount).toBe(2);
    expect(result.mapping.balance).toBe(3);
  });

  it("reads dates day-first", () => {
    expect(result.lines[1]?.date).toBe("2026-08-04");
    expect(result.lines[5]?.date).toBe("2026-08-31");
  });

  it("signs money out negative and money in positive", () => {
    expect(result.lines[1]?.amount.toDecimalString()).toBe("-1850.00");
    expect(result.lines[4]?.amount.toDecimalString()).toBe("7200.00");
  });

  it("keeps the quoted description intact", () => {
    expect(result.lines[1]?.description).toBe("DD RENT, AUGUST");
  });

  it("carries the balance column through", () => {
    expect(result.lines[0]?.balance?.toDecimalString()).toBe("25000.00");
  });

  it("keeps the raw row for later explanation", () => {
    expect(result.lines[1]?.raw["Description"]).toBe("DD RENT, AUGUST");
    expect(result.lines[1]?.sourceRow).toBe(1);
  });

  it("gives every line a stable id", () => {
    expect(result.lines.map((l) => l.id)).toEqual([
      "SL-0001",
      "SL-0002",
      "SL-0003",
      "SL-0004",
      "SL-0005",
      "SL-0006",
    ]);
  });

  it("summarises itself", () => {
    expect(describeImport(result)).toBe(
      "6 lines, 0 duplicates, 0 errors from 6 rows (DD/MM/YYYY, '.' decimal, GBP)",
    );
  });
});

describe("importing a European statement", () => {
  const DUTCH = [
    "Datum;Omschrijving;Bedrag;Saldo",
    "01-02-2026;ALBERT HEIJN, AMSTERDAM;-42,15;957,85",
    "02-02-2026;SALARIS FEBRUARI;2.500,00;3.457,85",
    "03-02-2026;HUUR MAART;-1.200,00;2.257,85",
  ].join("\n");

  const result = importCsv(DUTCH, { currency: "EUR" });

  it("detects semicolons and comma decimals", () => {
    expect(result.delimiter).toBe(";");
    expect(result.decimal).toBe("comma");
    expect(result.dateFormat).toBe("DD-MM-YYYY");
  });

  it("parses grouped amounts correctly", () => {
    expect(result.lines[0]?.amount.toDecimalString()).toBe("-42.15");
    expect(result.lines[1]?.amount.toDecimalString()).toBe("2500.00");
    expect(result.lines[2]?.amount.toDecimalString()).toBe("-1200.00");
  });

  it("keeps the comma inside a quoted-free semicolon field", () => {
    expect(result.lines[0]?.description).toBe("ALBERT HEIJN, AMSTERDAM");
  });
});

describe("debit and credit columns", () => {
  const TWO_COLUMN = [
    "Date,Description,Paid Out,Paid In,Balance",
    "01/08/2026,RENT,950.00,,50.00",
    "02/08/2026,SALARY,,2000.00,2050.00",
    "03/08/2026,REFUND,,12.50,2062.50",
  ].join("\n");

  const result = importCsv(TWO_COLUMN, { currency: GBP });

  it("combines them into one signed amount", () => {
    expect(result.errors).toEqual([]);
    expect(result.lines.map((l) => l.amount.toDecimalString())).toEqual([
      "-950.00",
      "2000.00",
      "12.50",
    ]);
  });

  it("reports the pair in the mapping", () => {
    expect(result.mapping.debit).toBe(2);
    expect(result.mapping.credit).toBe(3);
    expect(result.mapping.amount).toBeNull();
  });
});

describe("bad rows", () => {
  const MESSY = [
    "Date,Description,Amount",
    "01/08/2026,GOOD ROW,-10.00",
    ",MISSING DATE,-20.00",
    "31/02/2026,IMPOSSIBLE DATE,-30.00",
    "03/08/2026,NO AMOUNT,",
    "04/08/2026,BAD AMOUNT,not-a-number",
    "05/08/2026,ANOTHER GOOD ROW,-60.00",
  ].join("\n");

  const result = importCsv(MESSY, { currency: GBP });

  it("keeps the good rows", () => {
    expect(result.lines.map((l) => l.description)).toEqual(["GOOD ROW", "ANOTHER GOOD ROW"]);
  });

  it("reports each bad row with its index and reason", () => {
    expect(result.errors).toHaveLength(4);
    expect(result.errors[0]).toMatchObject({ row: 1, reason: "no date" });
    expect(result.errors[1]?.reason).toMatch(/not DD\/MM\/YYYY/);
    expect(result.errors[2]?.reason).toMatch(/empty/);
    expect(result.errors[3]?.reason).toMatch(/amount/i);
  });

  it("includes the offending cells for display", () => {
    expect(result.errors[0]?.cells).toContain("MISSING DATE");
  });

  it("never throws on a malformed file", () => {
    expect(() => importCsv("total nonsense", { currency: GBP })).not.toThrow();
    expect(() => importCsv("", { currency: GBP })).not.toThrow();
  });

  it("reports an empty file as zero rows", () => {
    const empty = importCsv("", { currency: GBP });
    expect(empty.lines).toEqual([]);
    expect(empty.rowsRead).toBe(0);
  });
});

describe("ambiguity handling", () => {
  const AMBIGUOUS = [
    "Date,Description,Amount",
    "01/02/2026,ONE,-10.00",
    "03/04/2026,TWO,-20.00",
  ].join("\n");

  it("warns when the date column cannot be settled", () => {
    const result = importCsv(AMBIGUOUS, { currency: GBP });
    expect(result.warnings.join(" ")).toMatch(/ambiguous between/);
  });

  it("accepts an explicit date format and drops the warning", () => {
    const result = importCsv(AMBIGUOUS, { currency: GBP, dateFormat: "MM/DD/YYYY" });
    expect(result.warnings.join(" ")).not.toMatch(/ambiguous/);
    expect(result.lines[0]?.date).toBe("2026-01-02");
    expect(result.lines[1]?.date).toBe("2026-03-04");
  });

  it("accepts explicit column overrides", () => {
    const odd = ["A,B,C", "RENT,01/08/2026,-950.00"].join("\n");
    const result = importCsv(odd, {
      currency: GBP,
      columns: { description: 0, date: 1, amount: 2 },
    });
    expect(result.lines[0]?.description).toBe("RENT");
    expect(result.lines[0]?.date).toBe("2026-08-01");
  });
});

describe("description normalisation", () => {
  it.each([
    ["SQ *COFFEE 4471", "COFFEE"],
    ["PAYPAL *ACME LTD", "ACME LTD"],
    ["CARD PAYMENT TO TESCO ON 04-AUG", "TO TESCO"],
    ["DD BRITISH GAS 12345678", "BRITISH GAS"],
    ["FPI ACME LTD INV1001", "ACME LTD INV1001"],
    ["  multiple   spaces  ", "MULTIPLE SPACES"],
  ])("reduces %s", (input, expected) => {
    expect(normaliseDescription(input)).toBe(expected);
  });

  it("makes two records of one purchase look alike", () => {
    expect(normaliseDescription("SQ *COFFEE HOUSE 4471")).toBe(
      normaliseDescription("SQ *COFFEE HOUSE 9982"),
    );
  });

  it("keeps genuinely different merchants apart", () => {
    expect(normaliseDescription("SQ *COFFEE HOUSE")).not.toBe(
      normaliseDescription("SQ *BOOK SHOP"),
    );
  });
});

describe("duplicate detection", () => {
  const line = (row: number, day: string, amount: string, description: string) =>
    statementLine({
      id: `L${row}`,
      date: date(day),
      description,
      amount: Money.parse(amount, GBP),
      sourceRow: row,
    });

  it("flags a repeated row within one batch", () => {
    const batch = [
      line(0, "2026-08-01", "-10.00", "COFFEE"),
      line(1, "2026-08-01", "-10.00", "COFFEE"),
    ];
    const report = findDuplicates(batch);
    expect(report.unique).toHaveLength(1);
    expect(report.flagged).toHaveLength(1);
    expect(report.flagged[0]?.kind).toBe("within-batch");
    expect(report.flagged[0]?.occurrence).toBe(2);
    expect(report.flagged[0]?.reason).toMatch(/repeats row 0/);
  });

  it("flags a line already imported", () => {
    const existing = [line(0, "2026-08-01", "-10.00", "COFFEE")];
    const batch = [line(0, "2026-08-01", "-10.00", "COFFEE")];
    const report = findDuplicates(batch, existing);
    expect(report.unique).toHaveLength(0);
    expect(report.flagged[0]?.kind).toBe("already-imported");
    expect(report.flagged[0]?.conflictsWith).toHaveLength(1);
  });

  it("does not flag genuinely different lines", () => {
    const batch = [
      line(0, "2026-08-01", "-10.00", "COFFEE"),
      line(1, "2026-08-01", "-10.00", "BOOKS"),
      line(2, "2026-08-02", "-10.00", "COFFEE"),
      line(3, "2026-08-01", "-11.00", "COFFEE"),
    ];
    expect(findDuplicates(batch).flagged).toEqual([]);
  });

  it("flags rather than drops, so a real second coffee can be kept", () => {
    const batch = [
      line(0, "2026-08-01", "-2.85", "SQ *COFFEE 1111"),
      line(1, "2026-08-01", "-2.85", "SQ *COFFEE 2222"),
    ];
    const report = findDuplicates(batch);
    // The terminal ids normalise away, so these look identical — and the tool
    // says so rather than silently deciding one of them did not happen.
    expect(report.flagged).toHaveLength(1);
    expect(report.flagged[0]?.line).toBeDefined();
    expect(report.unique).toHaveLength(1);
  });

  it("finds near-duplicates a few days apart", () => {
    const lines = [
      line(0, "2026-08-01", "-99.00", "ANNUAL FEE"),
      line(1, "2026-08-03", "-99.00", "ANNUAL FEE"),
      line(2, "2026-08-20", "-99.00", "ANNUAL FEE"),
    ];
    const near = findNearDuplicates(lines, { windowDays: 3 });
    expect(near).toHaveLength(1);
    expect(near[0]?.daysApart).toBe(2);
  });

  it("does not report exact same-day pairs as near-duplicates", () => {
    const lines = [
      line(0, "2026-08-01", "-99.00", "FEE"),
      line(1, "2026-08-01", "-99.00", "FEE"),
    ];
    expect(findNearDuplicates(lines)).toEqual([]);
  });

  it("runs duplicate detection as part of an import", () => {
    const withRepeat = [
      "Date,Description,Amount",
      "01/08/2026,COFFEE,-2.85",
      "01/08/2026,COFFEE,-2.85",
      "02/08/2026,BOOKS,-12.00",
    ].join("\n");
    const result = importCsv(withRepeat, { currency: GBP });
    expect(result.lines).toHaveLength(2);
    expect(result.duplicates).toHaveLength(1);
    expect(describeImport(result)).toMatch(/2 lines, 1 duplicate, 0 errors/);
  });

  it("compares an import against lines already held", () => {
    const first = importCsv(UK_STATEMENT, { currency: GBP });
    const second = importCsv(UK_STATEMENT, { currency: GBP, existing: first.lines });
    expect(second.lines).toEqual([]);
    expect(second.duplicates).toHaveLength(6);
    expect(second.duplicates.every((d) => d.kind === "already-imported")).toBe(true);
  });
});
