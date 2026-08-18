import { describe, expect, it } from "vitest";
import { NoRateError, RateTable } from "../src/fx/table.js";
import { RateError } from "../src/fx/rate.js";
import { Money } from "../src/money/money.js";
import { CHF, EUR, GBP, JPY, USD } from "../src/money/currency.js";

const ecb = RateTable.of([
  { date: "2026-03-11", base: "EUR", quote: "GBP", rate: "0.8400", source: "ecb" },
  { date: "2026-03-12", base: "EUR", quote: "GBP", rate: "0.8450", source: "ecb" },
  { date: "2026-03-13", base: "EUR", quote: "GBP", rate: "0.8473", source: "ecb" },
  { date: "2026-03-13", base: "EUR", quote: "USD", rate: "1.0837", source: "ecb" },
  { date: "2026-03-13", base: "EUR", quote: "CHF", rate: "0.9550", source: "ecb" },
]);

describe("finding a direct quote", () => {
  it("uses the quote published on the day asked about", () => {
    const found = ecb.lookup(EUR, GBP, "2026-03-13");
    expect(found.rate.toDecimalString(4)).toBe("0.8473");
    expect(found.direct).toBe(true);
    expect(found.staleDays).toBe(0);
    expect(found.via).toEqual(["EUR", "GBP"]);
    expect(found.sources).toEqual(["ecb"]);
  });

  it("reaches back over a weekend to the last published close", () => {
    // 2026-03-13 is a Friday; the 15th is the Sunday after it.
    const found = ecb.lookup(EUR, GBP, "2026-03-15");
    expect(found.rate.toDecimalString(4)).toBe("0.8473");
    expect(found.staleDays).toBe(2);
    expect(found.quoteDates).toEqual(["2026-03-13"]);
  });

  it("never reaches forward to a quote published later", () => {
    const found = ecb.lookup(EUR, GBP, "2026-03-12");
    expect(found.rate.toDecimalString(4)).toBe("0.8450");
  });

  it("refuses when the nearest quote is staler than the bound allows", () => {
    expect(() => ecb.lookup(EUR, GBP, "2026-04-30")).toThrow(NoRateError);
    try {
      ecb.lookup(EUR, GBP, "2026-04-30");
    } catch (error) {
      expect((error as Error).message).toContain("48 days stale");
      expect((error as Error).message).toContain("limit 4");
    }
  });

  it("refuses when every quote is after the date asked about", () => {
    expect(() => ecb.lookup(EUR, GBP, "2026-01-01")).toThrow(NoRateError);
    try {
      ecb.lookup(EUR, GBP, "2026-01-01");
    } catch (error) {
      expect((error as Error).message).toContain("after the date asked for");
    }
  });

  it("takes a wider staleness bound when told to", () => {
    const patient = ecb.withOptions({ maxStaleDays: 60 });
    expect(patient.lookup(EUR, GBP, "2026-04-30").staleDays).toBe(48);
  });

  it("refuses a pair of one currency", () => {
    expect(() => ecb.lookup(EUR, EUR, "2026-03-13")).toThrow(RateError);
  });

  it("says the table is empty rather than inventing a path", () => {
    expect(() => RateTable.empty().lookup(EUR, GBP, "2026-03-13")).toThrow(/table is empty/);
  });
});

describe("inversion", () => {
  it("answers the reverse of a quoted pair", () => {
    const found = ecb.lookup(GBP, EUR, "2026-03-13");
    expect(found.direct).toBe(true);
    expect(found.via).toEqual(["GBP", "EUR"]);
    expect(found.rate.toDecimalString(6)).toBe("1.180220");
  });

  it("inverting the answer returns the quoted price exactly", () => {
    const forward = ecb.lookup(EUR, GBP, "2026-03-13").rate;
    const backward = ecb.lookup(GBP, EUR, "2026-03-13").rate;
    expect(backward.inverse().equals(forward)).toBe(true);
  });

  it("prefers the fresher side when a pair is quoted in both directions", () => {
    const both = RateTable.of([
      { date: "2026-03-10", base: "EUR", quote: "GBP", rate: "0.8400", source: "old" },
      { date: "2026-03-13", base: "GBP", quote: "EUR", rate: "1.2000", source: "new" },
    ]);
    const found = both.lookup(EUR, GBP, "2026-03-13");
    expect(found.sources).toEqual(["new"]);
    expect(found.rate.toDecimalString(6)).toBe("0.833333");
  });

  it("prefers the forward quote when both sides are equally fresh", () => {
    const both = RateTable.of([
      { date: "2026-03-13", base: "EUR", quote: "GBP", rate: "0.8400", source: "forward" },
      { date: "2026-03-13", base: "GBP", quote: "EUR", rate: "1.2000", source: "backward" },
    ]);
    expect(both.lookup(EUR, GBP, "2026-03-13").sources).toEqual(["forward"]);
  });
});

describe("triangulation", () => {
  it("goes through a pivot currency when the pair is not quoted", () => {
    const found = ecb.lookup(USD, GBP, "2026-03-13");
    expect(found.direct).toBe(false);
    expect(found.via).toEqual(["USD", "EUR", "GBP"]);
    // (1 / 1.0837) * 0.8473 = 0.78185...
    expect(found.rate.toDecimalString(6)).toBe("0.781858");
  });

  it("composes exactly, with no intermediate rounding", () => {
    const usdGbp = ecb.lookup(USD, GBP, "2026-03-13").rate;
    const eurUsd = ecb.lookup(EUR, USD, "2026-03-13").rate;
    const eurGbp = ecb.lookup(EUR, GBP, "2026-03-13").rate;
    expect(eurUsd.then(usdGbp).equals(eurGbp)).toBe(true);
  });

  it("takes the fewest legs available", () => {
    const found = ecb.lookup(USD, CHF, "2026-03-13");
    expect(found.via).toEqual(["USD", "EUR", "CHF"]);
    expect(found.quoteDates).toHaveLength(2);
  });

  it("reports the oldest leg as the staleness of the whole answer", () => {
    const mixed = RateTable.of([
      { date: "2026-03-10", base: "EUR", quote: "USD", rate: "1.0800" },
      { date: "2026-03-13", base: "EUR", quote: "GBP", rate: "0.8473" },
    ]);
    const found = mixed.lookup(USD, GBP, "2026-03-13");
    expect(found.staleDays).toBe(3);
    expect(found.quoteDates).toEqual(["2026-03-10", "2026-03-13"]);
  });

  it("will not cross a leg that is itself too stale", () => {
    const mixed = RateTable.of([
      { date: "2026-01-02", base: "EUR", quote: "USD", rate: "1.0800" },
      { date: "2026-03-13", base: "EUR", quote: "GBP", rate: "0.8473" },
    ]);
    expect(() => mixed.lookup(USD, GBP, "2026-03-13")).toThrow(NoRateError);
  });

  it("names the currencies it could reach when there is no path at all", () => {
    try {
      ecb.lookup(JPY, GBP, "2026-03-13");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("no path through the quoted currencies");
      expect((error as Error).message).toContain("CHF, EUR, GBP, USD");
    }
  });

  it("respects a leg limit", () => {
    const chain = RateTable.of(
      [
        { date: "2026-03-13", base: "GBP", quote: "EUR", rate: "1.2" },
        { date: "2026-03-13", base: "EUR", quote: "USD", rate: "1.1" },
        { date: "2026-03-13", base: "USD", quote: "CHF", rate: "0.9" },
        { date: "2026-03-13", base: "CHF", quote: "JPY", rate: "170" },
      ],
      { maxLegs: 2 },
    );
    expect(chain.lookup(GBP, USD, "2026-03-13").via).toEqual(["GBP", "EUR", "USD"]);
    expect(() => chain.lookup(GBP, JPY, "2026-03-13")).toThrow(NoRateError);
    expect(chain.withOptions({ maxLegs: 4 }).lookup(GBP, JPY, "2026-03-13").via).toEqual([
      "GBP",
      "EUR",
      "USD",
      "CHF",
      "JPY",
    ]);
  });

  it("gives the same answer whatever order the quotes were added in", () => {
    const forwards = RateTable.of([
      { date: "2026-03-13", base: "EUR", quote: "USD", rate: "1.0837" },
      { date: "2026-03-13", base: "EUR", quote: "GBP", rate: "0.8473" },
      { date: "2026-03-13", base: "EUR", quote: "CHF", rate: "0.9550" },
    ]);
    const backwards = RateTable.of([
      { date: "2026-03-13", base: "EUR", quote: "CHF", rate: "0.9550" },
      { date: "2026-03-13", base: "EUR", quote: "GBP", rate: "0.8473" },
      { date: "2026-03-13", base: "EUR", quote: "USD", rate: "1.0837" },
    ]);
    expect(forwards.lookup(USD, CHF, "2026-03-13").via).toEqual(
      backwards.lookup(USD, CHF, "2026-03-13").via,
    );
  });
});

describe("the table itself", () => {
  it("counts its quotes and lists its pairs", () => {
    expect(ecb.size).toBe(5);
    expect(ecb.pairs()).toEqual(["EUR/CHF", "EUR/GBP", "EUR/USD"]);
    expect(ecb.currencies()).toEqual(["CHF", "EUR", "GBP", "USD"]);
  });

  it("is immutable — adding a quote returns a new table", () => {
    const extended = ecb.with({ date: "2026-03-16", base: "EUR", quote: "GBP", rate: "0.8500" });
    expect(ecb.size).toBe(5);
    expect(extended.size).toBe(6);
    expect(extended.lookup(EUR, GBP, "2026-03-16").rate.toDecimalString(4)).toBe("0.8500");
  });

  it("lets a correction replace a quote for the same pair and day", () => {
    const corrected = ecb.with({
      date: "2026-03-13",
      base: "EUR",
      quote: "GBP",
      rate: "0.8480",
      source: "ecb-revised",
    });
    expect(corrected.size).toBe(5);
    expect(corrected.lookup(EUR, GBP, "2026-03-13").rate.toDecimalString(4)).toBe("0.8480");
  });

  it("keeps a pair's quotes in date order however they arrive", () => {
    const shuffled = RateTable.of([
      { date: "2026-03-13", base: "EUR", quote: "GBP", rate: "0.8473" },
      { date: "2026-03-11", base: "EUR", quote: "GBP", rate: "0.8400" },
      { date: "2026-03-12", base: "EUR", quote: "GBP", rate: "0.8450" },
    ]);
    expect(shuffled.quotesFor(EUR, GBP).map((q) => q.date)).toEqual([
      "2026-03-11",
      "2026-03-12",
      "2026-03-13",
    ]);
  });

  it("sorts every quote by date then pair", () => {
    expect(ecb.all().map((q) => `${q.date} ${q.rate.pair}`)).toEqual([
      "2026-03-11 EUR/GBP",
      "2026-03-12 EUR/GBP",
      "2026-03-13 EUR/CHF",
      "2026-03-13 EUR/GBP",
      "2026-03-13 EUR/USD",
    ]);
  });

  it("answers has() without throwing", () => {
    expect(ecb.has(EUR, GBP, "2026-03-13")).toBe(true);
    expect(ecb.has(JPY, GBP, "2026-03-13")).toBe(false);
  });
});

describe("converting through the table", () => {
  it("converts an amount at the rate in force", () => {
    const converted = ecb.convert(Money.parse("1000.00", EUR), GBP, "2026-03-13");
    expect(converted.toString()).toBe("847.30 GBP");
  });

  it("passes an amount already in the target currency straight through", () => {
    const same = Money.parse("1000.00", GBP);
    expect(ecb.convert(same, GBP, "2026-03-13")).toBe(same);
  });

  it("converts through a triangulated rate", () => {
    const converted = ecb.convert(Money.parse("1000.00", USD), GBP, "2026-03-13");
    expect(converted.toString()).toBe("781.86 GBP");
  });

  it("honours the rounding mode", () => {
    const down = ecb.convert(Money.parse("1000.00", USD), GBP, "2026-03-13", "down");
    expect(down.toString()).toBe("781.85 GBP");
  });
});
