/**
 * Forcing the decimal convention, and saying so when it contradicts the file.
 *
 * `decimal` is an override and overrides win: a caller who knows the bank
 * better than the detector does should be able to say so. The problem is what
 * happens when they are wrong, because the two conventions differ by a factor
 * of a hundred and both parse cleanly. `-123,45` read as dots is `-12345.00`,
 * and there is no error anywhere to show for it — the row imports, the
 * statement reconciles against nothing, and the only evidence is a figure that
 * is out by two orders of magnitude.
 *
 * So the override still wins and the warning is now raised, on the same
 * condition the date column has always used: the detector was confident, and
 * it disagreed.
 */

import { describe, expect, it } from "vitest";
import { importCsv } from "../src/statement/import.js";

/** A continental statement: semicolons, commas for decimals, dots for groups. */
const CONTINENTAL =
  "Date;Description;Amount\n01/03/2026;KAUFLAND;-123,45\n02/03/2026;GEHALT;2.500,00\n";

/** A British one: commas between fields, dots for decimals. */
const BRITISH = "Date,Description,Amount\n2026-03-01,CARD TAKINGS,1234.56\n2026-03-02,RENT,-950.00\n";

const amounts = (text: string, options: Parameters<typeof importCsv>[1] = {}): string[] =>
  importCsv(text, options).lines.map((line) => line.amount.toDecimalString());

const conventionWarnings = (text: string, options: Parameters<typeof importCsv>[1] = {}): string[] =>
  importCsv(text, options).warnings.filter((warning) => warning.includes("decimal separator"));

describe("the convention is detected when nothing is said", () => {
  it("reads a continental file as commas", () => {
    const result = importCsv(CONTINENTAL);
    expect(result.decimal).toBe("comma");
    expect(amounts(CONTINENTAL)).toEqual(["-123.45", "2500.00"]);
    expect(conventionWarnings(CONTINENTAL)).toEqual([]);
  });

  it("reads a British file as dots", () => {
    expect(importCsv(BRITISH).decimal).toBe("dot");
    expect(amounts(BRITISH)).toEqual(["1234.56", "-950.00"]);
    expect(conventionWarnings(BRITISH)).toEqual([]);
  });
});

describe("the override wins", () => {
  it("is reported back, so the caller can see what was used", () => {
    expect(importCsv(CONTINENTAL, { decimal: "comma" }).decimal).toBe("comma");
    expect(importCsv(CONTINENTAL, { decimal: "dot" }).decimal).toBe("dot");
  });

  it("agreeing with the file changes nothing and says nothing", () => {
    expect(amounts(CONTINENTAL, { decimal: "comma" })).toEqual(amounts(CONTINENTAL));
    expect(conventionWarnings(CONTINENTAL, { decimal: "comma" })).toEqual([]);
    expect(conventionWarnings(BRITISH, { decimal: "dot" })).toEqual([]);
  });

  it("disagreeing with the file still reads it as asked", () => {
    // The hundredfold, in both directions. These are the figures the override
    // produces, not the ones anybody wants.
    expect(amounts(CONTINENTAL, { decimal: "dot" })).toEqual(["-12345.00", "2.50"]);
    expect(amounts(BRITISH, { decimal: "comma" })).toEqual(["123456.00", "-95000.00"]);
    expect(importCsv(CONTINENTAL, { decimal: "dot" }).errors).toEqual([]);
  });
});

describe("disagreeing with a confident column is warned about", () => {
  it("warns when dots are forced onto a comma file", () => {
    const warnings = conventionWarnings(CONTINENTAL, { decimal: "dot" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /Amounts look like they use ',' as the decimal separator, but '\.' was asked for; reading them as asked\./,
    );
  });

  it("warns when commas are forced onto a dot file", () => {
    const warnings = conventionWarnings(BRITISH, { decimal: "comma" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Amounts look like they use '.' as the decimal separator");
    expect(warnings[0]).toContain("',' was asked for");
  });

  it("does not warn when the detector was not confident", () => {
    // Whole pounds and no separator at all: there is nothing in the column to
    // disagree with, so an override is the caller supplying what the file
    // cannot, which is the case the option exists for.
    const ambiguous = "Date,Description,Amount\n2026-03-01,TAKINGS,1200\n2026-03-02,RENT,-950\n";
    // That the column really is unconfident is the premise of this test, so
    // it is asserted rather than assumed: left alone, the import says it
    // could not tell.
    expect(importCsv(ambiguous).warnings.some((w) => w.includes("Could not tell"))).toBe(true);
    // And with the option set there is nothing to contradict, so neither
    // warning is raised.
    expect(conventionWarnings(ambiguous, { decimal: "comma" })).toEqual([]);
    expect(conventionWarnings(ambiguous, { decimal: "dot" })).toEqual([]);
  });

  it("does not warn about a file with no amounts in it", () => {
    const empty = "Date,Description,Amount\n";
    expect(conventionWarnings(empty, { decimal: "comma" })).toEqual([]);
  });

  it("leaves the existing unconfident warning alone", () => {
    // The two warnings are mutually exclusive by construction — one needs the
    // option unset and the other needs it set — and this pins that rather
    // than assuming it.
    const ambiguous = "Date,Description,Amount\n2026-03-01,TAKINGS,1.234\n";
    const unset = importCsv(ambiguous).warnings.filter((w) => w.includes("decimal separator"));
    const set = conventionWarnings(ambiguous, { decimal: "dot" });
    expect(unset.length + set.length).toBeLessThanOrEqual(1);
  });
});
