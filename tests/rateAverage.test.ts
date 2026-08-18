import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { averageRate, dailyAverage, meanOfRates, quotedAverage } from "../src/fx/average.js";
import { ExchangeRate, RateError, rate } from "../src/fx/rate.js";
import { NoRateError, RateTable } from "../src/fx/table.js";
import { EUR, GBP, USD } from "../src/money/currency.js";
import { dateRange } from "../src/ledger/date.js";

// 2026-03-09 is a Monday, so this is one full trading week.
const week = RateTable.of([
  { date: "2026-03-09", base: "EUR", quote: "GBP", rate: "0.8400" },
  { date: "2026-03-10", base: "EUR", quote: "GBP", rate: "0.8420" },
  { date: "2026-03-11", base: "EUR", quote: "GBP", rate: "0.8440" },
  { date: "2026-03-12", base: "EUR", quote: "GBP", rate: "0.8460" },
  { date: "2026-03-13", base: "EUR", quote: "GBP", rate: "0.8480" },
]);

describe("the mean of a list of rates", () => {
  it("is exact where a float would drift", () => {
    const mean = meanOfRates([rate("0.1", EUR, GBP), rate("0.2", EUR, GBP)]);
    expect(mean.toDecimalString(20)).toBe("0.15000000000000000000");
  });

  it("averages thirds without losing them", () => {
    const mean = meanOfRates([
      ExchangeRate.ofRatio(1n, 3n, EUR, GBP),
      ExchangeRate.ofRatio(2n, 3n, EUR, GBP),
    ]);
    expect(mean.numerator).toBe(1n);
    expect(mean.denominator).toBe(2n);
  });

  it("does not depend on the order it is given", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 50000 }), { minLength: 2, maxLength: 30 }),
        (prices) => {
          const rates = prices.map((p) => ExchangeRate.ofRatio(BigInt(p), 10000n, EUR, GBP));
          const forward = meanOfRates(rates);
          const backward = meanOfRates([...rates].reverse());
          expect(forward.equals(backward)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("lies between the smallest and largest it was given", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 50000 }), { minLength: 1, maxLength: 30 }),
        (prices) => {
          const rates = prices.map((p) => ExchangeRate.ofRatio(BigInt(p), 10000n, EUR, GBP));
          const mean = meanOfRates(rates);
          const lowest = ExchangeRate.ofRatio(BigInt(Math.min(...prices)), 10000n, EUR, GBP);
          const highest = ExchangeRate.ofRatio(BigInt(Math.max(...prices)), 10000n, EUR, GBP);
          expect(mean.compare(lowest)).toBeGreaterThanOrEqual(0);
          expect(mean.compare(highest)).toBeLessThanOrEqual(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("refuses an empty list and a mixed pair", () => {
    expect(() => meanOfRates([])).toThrow(RateError);
    expect(() => meanOfRates([rate("0.84", EUR, GBP), rate("1.08", EUR, USD)])).toThrow(RateError);
  });

  it("stays cheap over a year of daily quotes", () => {
    const rates = Array.from({ length: 365 }, (_, i) =>
      ExchangeRate.ofRatio(BigInt(8400 + i), 10000n, EUR, GBP),
    );
    const mean = meanOfRates(rates);
    // An arithmetic series: the mean is the midpoint of the first and last.
    expect(mean.toDecimalString(4)).toBe("0.8582");
    expect(mean.denominator < 10n ** 8n).toBe(true);
  });
});

describe("the average of the quotes actually published", () => {
  it("averages the trading days in the range", () => {
    const found = quotedAverage(week, EUR, GBP, dateRange("2026-03-09", "2026-03-13"));
    expect(found.observations).toBe(5);
    expect(found.method).toBe("quoted");
    expect(found.rate.toDecimalString(4)).toBe("0.8440");
  });

  it("reports the range it saw", () => {
    const found = quotedAverage(week, EUR, GBP, dateRange("2026-03-10", "2026-03-12"));
    expect(found.dates).toEqual(["2026-03-10", "2026-03-11", "2026-03-12"]);
    expect(found.lowest.toDecimalString(4)).toBe("0.8420");
    expect(found.highest.toDecimalString(4)).toBe("0.8460");
  });

  it("counts a day quoted for any pair, answering this one by triangulation", () => {
    const mixed = RateTable.of([
      { date: "2026-03-12", base: "EUR", quote: "GBP", rate: "0.8460" },
      { date: "2026-03-12", base: "EUR", quote: "USD", rate: "1.0800" },
      { date: "2026-03-13", base: "EUR", quote: "USD", rate: "1.0900" },
    ]);
    const found = quotedAverage(mixed, USD, GBP, dateRange("2026-03-12", "2026-03-13"));
    expect(found.observations).toBe(2);
    // 0.8460/1.08 = 0.783333..., 0.8460/1.09 = 0.776146...
    expect(found.rate.toDecimalString(6)).toBe("0.779740");
  });

  it("refuses a range with no quotes in it", () => {
    expect(() => quotedAverage(week, EUR, GBP, dateRange("2026-06-01", "2026-06-30"))).toThrow(
      NoRateError,
    );
  });
});

describe("the average of one rate per calendar day", () => {
  it("carries the last close forward over a weekend", () => {
    // Saturday and Sunday both take Friday's 0.8480.
    const found = dailyAverage(week, EUR, GBP, dateRange("2026-03-09", "2026-03-15"));
    expect(found.observations).toBe(7);
    // (0.8400+0.8420+0.8440+0.8460+0.8480*3)/7
    expect(found.rate.toDecimalString(6)).toBe("0.845143");
  });

  it("weights a weekend where the quoted average does not", () => {
    const range = dateRange("2026-03-09", "2026-03-15");
    const daily = dailyAverage(week, EUR, GBP, range);
    const quoted = quotedAverage(week, EUR, GBP, range);
    expect(daily.observations).toBe(7);
    expect(quoted.observations).toBe(5);
    expect(daily.rate.compare(quoted.rate)).toBe(1);
  });

  it("stops at a day it cannot price", () => {
    expect(() => dailyAverage(week, EUR, GBP, dateRange("2026-03-01", "2026-03-13"))).toThrow(
      NoRateError,
    );
  });

  it("skips unpriceable days only when told to", () => {
    const found = dailyAverage(week, EUR, GBP, dateRange("2026-03-01", "2026-03-13"), {
      skipMissing: true,
    });
    expect(found.observations).toBe(5);
    expect(found.dates[0]).toBe("2026-03-09");
  });

  it("averages a single day to that day's rate", () => {
    const found = dailyAverage(week, EUR, GBP, dateRange("2026-03-11", "2026-03-11"));
    expect(found.rate.toDecimalString(4)).toBe("0.8440");
    expect(found.observations).toBe(1);
  });
});

describe("choosing a method by name", () => {
  it("defaults to the daily average", () => {
    const chosen = averageRate(week, EUR, GBP, "2026-03-09", "2026-03-15");
    expect(chosen.method).toBe("daily");
    expect(chosen.observations).toBe(7);
  });

  it("takes the quoted average when asked", () => {
    const chosen = averageRate(week, EUR, GBP, "2026-03-09", "2026-03-15", "quoted");
    expect(chosen.method).toBe("quoted");
    expect(chosen.observations).toBe(5);
  });
});
