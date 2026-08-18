import { describe, expect, it } from "vitest";
import {
  RateDocumentError,
  ratesFromCsv,
  ratesFromJson,
  ratesFromText,
  ratesToDocument,
  ratesToJson,
} from "../src/fx/document.js";
import { RateTable } from "../src/fx/table.js";
import { EUR, GBP, USD } from "../src/money/currency.js";

const table = RateTable.of(
  [
    { date: "2026-03-12", base: "EUR", quote: "GBP", rate: "0.8450", source: "ecb" },
    { date: "2026-03-13", base: "EUR", quote: "GBP", rate: "0.8473", source: "ecb" },
    { date: "2026-03-13", base: "EUR", quote: "USD", rate: "1.0837", source: "ecb" },
  ],
  { maxStaleDays: 7 },
);

describe("the JSON document", () => {
  it("writes every quote, with its direction and source", () => {
    const doc = ratesToDocument(table);
    expect(doc.version).toBe(1);
    expect(doc.maxStaleDays).toBe(7);
    expect(doc.quotes).toHaveLength(3);
    expect(doc.quotes[0]).toEqual({
      date: "2026-03-12",
      base: "EUR",
      quote: "GBP",
      rate: "0.8450000000",
      source: "ecb",
    });
  });

  it("writes rates as strings, never as JSON numbers", () => {
    expect(ratesToJson(table)).not.toMatch(/"rate":\s*[0-9]/);
  });

  it("round-trips a table without changing a single price", () => {
    const back = ratesFromJson(ratesToJson(table));
    expect(back.size).toBe(table.size);
    expect(back.maxStaleDays).toBe(7);
    for (const quote of table.all()) {
      const found = back.lookup(quote.rate.base, quote.rate.quote, quote.date);
      expect(found.rate.equals(quote.rate)).toBe(true);
    }
  });

  it("omits a source that carries no information", () => {
    const manual = RateTable.of([{ date: "2026-03-13", base: "EUR", quote: "GBP", rate: "0.85" }]);
    expect(ratesToDocument(manual).quotes[0]).not.toHaveProperty("source");
  });

  it("rejects a document that is not an object", () => {
    expect(() => ratesFromJson("[]")).toThrow(RateDocumentError);
    expect(() => ratesFromJson("null")).toThrow(RateDocumentError);
  });

  it("rejects a version it does not understand", () => {
    expect(() => ratesFromJson('{"version":2,"quotes":[]}')).toThrow(/version/);
  });

  it("rejects a rate given as a number", () => {
    expect(() =>
      ratesFromJson(
        '{"version":1,"quotes":[{"date":"2026-03-13","base":"EUR","quote":"GBP","rate":0.8473}]}',
      ),
    ).toThrow(/must be a string/);
  });

  it("rejects an unknown currency", () => {
    expect(() =>
      ratesFromJson(
        '{"version":1,"quotes":[{"date":"2026-03-13","base":"XYZ","quote":"GBP","rate":"0.8"}]}',
      ),
    ).toThrow(/unknown currency/);
  });

  it("rejects a date that is not a calendar date", () => {
    expect(() =>
      ratesFromJson(
        '{"version":1,"quotes":[{"date":"13/03/2026","base":"EUR","quote":"GBP","rate":"0.8"}]}',
      ),
    ).toThrow(/calendar date/);
  });

  it("rejects a negative rate at load rather than in a revaluation", () => {
    expect(() =>
      ratesFromJson(
        '{"version":1,"quotes":[{"date":"2026-03-13","base":"EUR","quote":"GBP","rate":"-0.8"}]}',
      ),
    ).toThrow(/rejected/);
  });

  it("rejects a staleness bound that is not a count", () => {
    expect(() => ratesFromJson('{"version":1,"maxStaleDays":-1,"quotes":[]}')).toThrow(
      /non-negative integer/,
    );
  });

  it("reports where the JSON broke", () => {
    expect(() => ratesFromJson("{oops")).toThrow(/not valid JSON/);
  });
});

describe("the wide CSV a rate provider actually publishes", () => {
  const csv = [
    "Date,USD,GBP,CHF",
    "2026-03-11,1.0821,0.8400,0.9540",
    "2026-03-12,1.0829,0.8450,0.9545",
    "2026-03-13,1.0837,0.8473,0.9550",
  ].join("\n");

  it("reads one row per date and one column per currency", () => {
    const read = ratesFromCsv(csv, { base: "EUR", source: "ecb" });
    expect(read.size).toBe(9);
    expect(read.pairs()).toEqual(["EUR/CHF", "EUR/GBP", "EUR/USD"]);
    expect(read.lookup(EUR, GBP, "2026-03-13").rate.toDecimalString(4)).toBe("0.8473");
    expect(read.lookup(EUR, GBP, "2026-03-13").sources).toEqual(["ecb"]);
  });

  it("supports headers that name the pair outright", () => {
    const paired = ["date,EUR/GBP,GBP/USD", "2026-03-13,0.8473,1.2800"].join("\n");
    const read = ratesFromCsv(paired);
    expect(read.pairs()).toEqual(["EUR/GBP", "GBP/USD"]);
    expect(read.lookup(GBP, USD, "2026-03-13").rate.toDecimalString(2)).toBe("1.28");
  });

  it("insists on a base currency when the columns are bare codes", () => {
    expect(() => ratesFromCsv(csv)).toThrow(/base currency must be given/);
  });

  it("skips the base's own column of ones", () => {
    const withSelf = ["Date,EUR,USD", "2026-03-13,1.0000,1.0837"].join("\n");
    const read = ratesFromCsv(withSelf, { base: "EUR" });
    expect(read.pairs()).toEqual(["EUR/USD"]);
  });

  it("treats a blank cell as a market holiday, not a zero", () => {
    const gappy = ["Date,USD,GBP", "2026-03-12,1.0829,", "2026-03-13,1.0837,0.8473"].join("\n");
    const read = ratesFromCsv(gappy, { base: "EUR" });
    expect(read.quotesFor(EUR, GBP).map((q) => q.date)).toEqual(["2026-03-13"]);
    expect(read.quotesFor(EUR, USD)).toHaveLength(2);
  });

  it("treats a dash and an n/a the same way", () => {
    const gappy = ["Date,USD,GBP", "2026-03-13,-,N/A", "2026-03-14,1.0837,0.8473"].join("\n");
    expect(ratesFromCsv(gappy, { base: "EUR" }).size).toBe(2);
  });

  it("inverts every quote when the file is published the other way up", () => {
    const read = ratesFromCsv(["Date,USD", "2026-03-13,1.0837"].join("\n"), {
      base: "EUR",
      invert: true,
    });
    // The cell now reads "one USD buys 1.0837 EUR", so the euro is the weaker side.
    expect(read.pairs()).toEqual(["USD/EUR"]);
    expect(read.lookup(USD, EUR, "2026-03-13").rate.toDecimalString(4)).toBe("1.0837");
    expect(read.lookup(EUR, USD, "2026-03-13").rate.toDecimalString(4)).toBe("0.9228");
  });

  it("skips a bank's preamble to find the header", () => {
    const withPreamble = [
      "Euro foreign exchange reference rates",
      "",
      "Date,USD,GBP",
      "2026-03-13,1.0837,0.8473",
    ].join("\n");
    expect(ratesFromCsv(withPreamble, { base: "EUR" }).size).toBe(2);
  });

  it("sniffs a semicolon-delimited export", () => {
    const semi = ["Date;USD;GBP", "2026-03-13;1.0837;0.8473"].join("\n");
    expect(ratesFromCsv(semi, { base: "EUR" }).size).toBe(2);
  });

  it("refuses a file with no date column", () => {
    expect(() => ratesFromCsv("USD,GBP\n1.08,0.84", { base: "EUR" })).toThrow(/No date column/);
  });

  it("refuses a date that is not YYYY-MM-DD, naming the row", () => {
    expect(() => ratesFromCsv("Date,USD\n13/03/2026,1.08", { base: "EUR" })).toThrow(/Row 1/);
  });

  it("refuses an unknown currency column", () => {
    expect(() => ratesFromCsv("Date,XYZ\n2026-03-13,1.08", { base: "EUR" })).toThrow(
      /unknown currency/,
    );
  });

  it("refuses a file with no quotes in it", () => {
    expect(() => ratesFromCsv("Date,USD\n2026-03-13,", { base: "EUR" })).toThrow(
      /at least one quote/,
    );
  });
});

describe("reading whichever format arrived", () => {
  it("takes JSON when it looks like JSON", () => {
    expect(ratesFromText(ratesToJson(table)).size).toBe(3);
  });

  it("takes CSV otherwise", () => {
    expect(ratesFromText("Date,GBP\n2026-03-13,0.8473", { base: "EUR" }).size).toBe(1);
  });
});
