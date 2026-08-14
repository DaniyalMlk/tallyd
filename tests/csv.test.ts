import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  CsvParseError,
  parseCsv,
  readTable,
  sniffDelimiter,
  stripBom,
} from "../src/statement/csv.js";

describe("tokenizer", () => {
  it("parses a plain file", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles CRLF", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles a lone CR", () => {
    expect(parseCsv("a,b\r1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("strips a BOM", () => {
    expect(stripBom("﻿a")).toBe("a");
    expect(parseCsv("﻿a,b\n1,2")[0]).toEqual(["a", "b"]);
  });

  it("keeps delimiters inside quotes", () => {
    expect(parseCsv('a,"b,c",d')).toEqual([["a", "b,c", "d"]]);
  });

  it("unescapes doubled quotes", () => {
    expect(parseCsv('a,"say ""hi""",c')).toEqual([["a", 'say "hi"', "c"]]);
  });

  it("allows a newline inside a quoted field", () => {
    expect(parseCsv('a,"line1\nline2",c')).toEqual([["a", "line1\nline2", "c"]]);
  });

  it("preserves whitespace inside quotes but trims unquoted fields", () => {
    expect(parseCsv('a,"  spaced  ",  bare  ')).toEqual([["a", "  spaced  ", "bare"]]);
  });

  it("treats a bare quote mid-field as data", () => {
    expect(parseCsv('1,JOHN\'S 24" TV,3')).toEqual([["1", "JOHN'S 24\" TV", "3"]]);
  });

  it("keeps empty fields inside a row with content", () => {
    expect(parseCsv("a,,c")).toEqual([["a", "", "c"]]);
    expect(parseCsv("a,,")).toEqual([["a", "", ""]]);
  });

  it("drops a row whose fields are all empty", () => {
    // ",,," is a separator artefact, not a transaction. Statement exports are
    // full of them, and a row of blanks has nothing to import.
    expect(parseCsv(",,")).toEqual([]);
    expect(parseCsv("a,b\n,,\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("drops blank lines", () => {
    expect(parseCsv("a,b\n\n\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("returns nothing for empty input", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("\n\n")).toEqual([]);
    expect(parseCsv("   ")).toEqual([]);
  });

  it("rejects an unterminated quote, naming the line", () => {
    expect(() => parseCsv('a,"never closed\nnext line')).toThrow(CsvParseError);
    try {
      parseCsv('a,b\nc,"never closed');
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as CsvParseError).line).toBe(2);
    }
  });

  it("supports other delimiters", () => {
    expect(parseCsv("a;b;c", ";")).toEqual([["a", "b", "c"]]);
    expect(parseCsv("a\tb\tc", "\t")).toEqual([["a", "b", "c"]]);
  });

  it("round-trips any field content through quoting", () => {
    const fieldArb = fc.stringMatching(/^[a-zA-Z0-9 ,;"\t|-]{0,20}$/);
    fc.assert(
      fc.property(fc.array(fieldArb, { minLength: 1, maxLength: 6 }), (fields) => {
        const encoded = fields.map((f) => `"${f.replace(/"/g, '""')}"`).join(",");
        expect(parseCsv(encoded)).toEqual([fields.length === 1 && fields[0] === "" ? [] : fields]
          .filter((r) => r.length > 0));
      }),
      { numRuns: 200 },
    );
  });
});

describe("delimiter sniffing", () => {
  it.each([
    ["date,description,amount\n2026-01-01,Rent,-950.00", ","],
    ["date;description;amount\n2026-01-01;Rent;-950,00", ";"],
    ["date\tdescription\tamount\n2026-01-01\tRent\t-950.00", "\t"],
    ["date|description|amount\n2026-01-01|Rent|-950.00", "|"],
  ])("detects the delimiter in %#", (input, expected) => {
    expect(sniffDelimiter(input)).toBe(expected);
  });

  it("is not fooled by commas inside a semicolon-delimited file", () => {
    const input = [
      "Datum;Omschrijving;Bedrag",
      "01-02-2026;ALBERT HEIJN, AMSTERDAM;-42,15",
      "02-02-2026;SALARIS, FEBRUARI;2.500,00",
      "03-02-2026;HUUR, MAART;-1.200,00",
    ].join("\n");
    expect(sniffDelimiter(input)).toBe(";");
  });

  it("prefers the delimiter that gives consistent widths", () => {
    const input = [
      "date,description,amount",
      '2026-01-01,"COFFEE; SHOP",-3.50',
      '2026-01-02,"BOOKS; AND; MORE",-12.00',
    ].join("\n");
    expect(sniffDelimiter(input)).toBe(",");
  });

  it("falls back to comma on unusable input", () => {
    expect(sniffDelimiter("")).toBe(",");
    expect(sniffDelimiter("single-column\nvalues")).toBe(",");
  });
});

describe("readTable", () => {
  it("reads a header and rows", () => {
    const table = readTable("date,description,amount\n2026-01-01,Rent,-950.00");
    expect(table.header).toEqual(["date", "description", "amount"]);
    expect(table.rows).toEqual([["2026-01-01", "Rent", "-950.00"]]);
    expect(table.preambleLines).toBe(0);
  });

  it("skips a bank preamble to find the real header", () => {
    const input = [
      "Barclays Bank plc",
      "Account 12345678",
      "Statement period 01/08/2026 to 31/08/2026",
      "",
      "Date,Description,Amount,Balance",
      "01/08/2026,OPENING,0.00,1000.00",
      "02/08/2026,CARD PAYMENT,-12.99,987.01",
    ].join("\n");
    const table = readTable(input);
    expect(table.header).toEqual(["Date", "Description", "Amount", "Balance"]);
    expect(table.rows).toHaveLength(2);
    expect(table.preambleLines).toBe(3);
  });

  it("detects the delimiter itself", () => {
    const table = readTable("Datum;Bedrag\n01-02-2026;-42,15");
    expect(table.delimiter).toBe(";");
    expect(table.header).toEqual(["Datum", "Bedrag"]);
  });

  it("accepts an explicit delimiter", () => {
    const table = readTable("a|b\n1|2", { delimiter: "|" });
    expect(table.header).toEqual(["a", "b"]);
  });

  it("handles an empty file", () => {
    const table = readTable("");
    expect(table.header).toEqual([]);
    expect(table.rows).toEqual([]);
  });

  it("handles a header with no data rows", () => {
    const table = readTable("date,description,amount");
    expect(table.header).toHaveLength(3);
    expect(table.rows).toEqual([]);
  });
});
