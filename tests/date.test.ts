import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  InvalidDateError,
  addDays,
  compareDates,
  date,
  dateRange,
  dayOfWeek,
  daysBetween,
  daysInMonth,
  endOfMonth,
  fromEpochDay,
  isWeekend,
  startOfMonth,
  toEpochDay,
  withinRange,
} from "../src/ledger/date.js";

describe("validation", () => {
  it.each(["2026-01-01", "2024-02-29", "1999-12-31", "2000-02-29"])("accepts %s", (v) => {
    expect(date(v)).toBe(v);
  });

  it.each([
    "2026-02-29", // not a leap year
    "1900-02-29", // century, not a leap year
    "2026-13-01",
    "2026-00-10",
    "2026-01-32",
    "2026-1-1", // unpadded
    "26-01-01",
    "2026/01/01",
    "",
    "today",
  ])("rejects %s", (v) => {
    expect(() => date(v)).toThrow(InvalidDateError);
  });

  it("knows month lengths including leap years", () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(() => daysInMonth(2026, 13)).toThrow(RangeError);
  });
});

describe("epoch day arithmetic", () => {
  it.each([
    ["1970-01-01", 0],
    ["1970-01-02", 1],
    ["1969-12-31", -1],
    ["2000-01-01", 10957],
    ["2026-08-14", 20679],
  ])("maps %s to %i", (d, epoch) => {
    expect(toEpochDay(date(d))).toBe(epoch);
    expect(fromEpochDay(epoch)).toBe(d);
  });

  it("round-trips every date over a two-century span", () => {
    fc.assert(
      fc.property(fc.integer({ min: -36525, max: 36525 }), (epoch) => {
        expect(toEpochDay(fromEpochDay(epoch))).toBe(epoch);
      }),
      { numRuns: 500 },
    );
  });

  it("counts days between dates, signed", () => {
    expect(daysBetween(date("2026-01-01"), date("2026-01-08"))).toBe(7);
    expect(daysBetween(date("2026-01-08"), date("2026-01-01"))).toBe(-7);
    expect(daysBetween(date("2024-02-28"), date("2024-03-01"))).toBe(2);
    expect(daysBetween(date("2026-02-28"), date("2026-03-01"))).toBe(1);
  });

  it("adds days across month and year boundaries", () => {
    expect(addDays(date("2026-01-31"), 1)).toBe("2026-02-01");
    expect(addDays(date("2026-12-31"), 1)).toBe("2027-01-01");
    expect(addDays(date("2026-01-01"), -1)).toBe("2025-12-31");
    expect(addDays(date("2024-02-28"), 1)).toBe("2024-02-29");
  });

  it("is consistent: addDays then daysBetween is the identity", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 30000 }),
        fc.integer({ min: -400, max: 400 }),
        (epoch, delta) => {
          const start = fromEpochDay(epoch);
          expect(daysBetween(start, addDays(start, delta))).toBe(delta);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("calendar helpers", () => {
  it("knows the day of the week", () => {
    expect(dayOfWeek(date("1970-01-01"))).toBe(4); // a Thursday
    expect(dayOfWeek(date("2026-08-14"))).toBe(5); // a Friday
    expect(isWeekend(date("2026-08-15"))).toBe(true);
    expect(isWeekend(date("2026-08-14"))).toBe(false);
  });

  it("finds month boundaries", () => {
    expect(startOfMonth(date("2026-08-14"))).toBe("2026-08-01");
    expect(endOfMonth(date("2026-08-14"))).toBe("2026-08-31");
    expect(endOfMonth(date("2024-02-05"))).toBe("2024-02-29");
    expect(endOfMonth(date("2026-02-05"))).toBe("2026-02-28");
  });

  it("orders dates lexicographically", () => {
    expect(compareDates(date("2026-01-01"), date("2026-01-02"))).toBe(-1);
    expect(compareDates(date("2026-01-02"), date("2026-01-02"))).toBe(0);
    expect(compareDates(date("2026-02-01"), date("2026-01-31"))).toBe(1);
  });

  it("matches numeric ordering everywhere, so plain sort() is safe", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 30000 }),
        fc.integer({ min: 0, max: 30000 }),
        (a, b) => {
          const da = fromEpochDay(a);
          const db = fromEpochDay(b);
          expect(compareDates(da, db)).toBe(Math.sign(a - b));
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("ranges", () => {
  const range = dateRange("2026-08-01", "2026-08-31");

  it("includes both endpoints", () => {
    expect(withinRange(date("2026-08-01"), range)).toBe(true);
    expect(withinRange(date("2026-08-31"), range)).toBe(true);
    expect(withinRange(date("2026-07-31"), range)).toBe(false);
    expect(withinRange(date("2026-09-01"), range)).toBe(false);
  });

  it("rejects an inverted range", () => {
    expect(() => dateRange("2026-08-31", "2026-08-01")).toThrow(RangeError);
  });

  it("allows a single-day range", () => {
    const day = dateRange("2026-08-14", "2026-08-14");
    expect(withinRange(date("2026-08-14"), day)).toBe(true);
  });
});
