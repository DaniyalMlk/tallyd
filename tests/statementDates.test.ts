import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DATE_FORMATS,
  DateParseError,
  canParseIn,
  detectDateFormat,
  looksLikeDate,
  parseDateColumn,
  parseDateIn,
} from "../src/statement/dates.js";

describe("parsing in a known format", () => {
  it.each([
    ["2026-08-14", "YYYY-MM-DD", "2026-08-14"],
    ["2026/08/14", "YYYY/MM/DD", "2026-08-14"],
    ["14/08/2026", "DD/MM/YYYY", "2026-08-14"],
    ["08/14/2026", "MM/DD/YYYY", "2026-08-14"],
    ["14-08-2026", "DD-MM-YYYY", "2026-08-14"],
    ["14.08.2026", "DD.MM.YYYY", "2026-08-14"],
    ["14-Aug-2026", "DD-MMM-YYYY", "2026-08-14"],
    ["14 AUG 2026", "DD-MMM-YYYY", "2026-08-14"],
    ["Aug 14, 2026", "MMM DD, YYYY", "2026-08-14"],
    ["Sept 1, 2026", "MMM DD, YYYY", "2026-09-01"],
    ["1/2/2026", "DD/MM/YYYY", "2026-02-01"],
  ] as const)("reads %s as %s", (input, format, expected) => {
    expect(parseDateIn(input, format)).toBe(expected);
  });

  it("expands two-digit years around a 1970 pivot", () => {
    expect(parseDateIn("14/08/26", "DD/MM/YYYY")).toBe("2026-08-14");
    expect(parseDateIn("14/08/85", "DD/MM/YYYY")).toBe("1985-08-14");
  });

  it("rejects impossible dates rather than rolling them over", () => {
    expect(() => parseDateIn("31/02/2026", "DD/MM/YYYY")).toThrow(DateParseError);
    expect(() => parseDateIn("29/02/2026", "DD/MM/YYYY")).toThrow(DateParseError);
    expect(parseDateIn("29/02/2024", "DD/MM/YYYY")).toBe("2024-02-29");
    expect(() => parseDateIn("13/13/2026", "DD/MM/YYYY")).toThrow(DateParseError);
  });

  it("rejects a value in the wrong format", () => {
    expect(() => parseDateIn("2026-08-14", "DD/MM/YYYY")).toThrow(DateParseError);
    expect(() => parseDateIn("14/08/2026", "YYYY-MM-DD")).toThrow(DateParseError);
    expect(() => parseDateIn("not a date", "YYYY-MM-DD")).toThrow(DateParseError);
    expect(() => parseDateIn("14-Xyz-2026", "DD-MMM-YYYY")).toThrow(DateParseError);
  });

  it("names the format it tried", () => {
    expect(() => parseDateIn("nope", "DD/MM/YYYY")).toThrow(/as DD\/MM\/YYYY/);
  });

  it("reports parseability without throwing", () => {
    expect(canParseIn("14/08/2026", "DD/MM/YYYY")).toBe(true);
    expect(canParseIn("14/08/2026", "MM/DD/YYYY")).toBe(false);
    expect(looksLikeDate("2026-08-14")).toBe(true);
    expect(looksLikeDate("CARD PAYMENT")).toBe(false);
    expect(looksLikeDate("1234.56")).toBe(false);
  });
});

describe("format detection", () => {
  it("settles day-first from one unambiguous value", () => {
    const detection = detectDateFormat(["01/02/2026", "03/04/2026", "25/12/2026"]);
    expect(detection.format).toBe("DD/MM/YYYY");
    expect(detection.confident).toBe(true);
  });

  it("settles month-first from one unambiguous value", () => {
    const detection = detectDateFormat(["01/02/2026", "03/04/2026", "12/25/2026"]);
    expect(detection.format).toBe("MM/DD/YYYY");
    expect(detection.confident).toBe(true);
  });

  it("admits when a column cannot be settled", () => {
    const detection = detectDateFormat(["01/02/2026", "03/04/2026", "05/06/2026"]);
    expect(detection.confident).toBe(false);
    expect(detection.candidates).toContain("DD/MM/YYYY");
    expect(detection.candidates).toContain("MM/DD/YYYY");
  });

  it("lets the caller resolve an ambiguous column", () => {
    const detection = detectDateFormat(["01/02/2026", "03/04/2026"], {
      prefer: "MM/DD/YYYY",
    });
    expect(detection.format).toBe("MM/DD/YYYY");
    expect(detection.confident).toBe(true);
  });

  it("ignores a preference the data rules out", () => {
    const detection = detectDateFormat(["25/12/2026"], { prefer: "MM/DD/YYYY" });
    expect(detection.format).toBe("DD/MM/YYYY");
  });

  it("recognises ISO immediately and unambiguously", () => {
    const detection = detectDateFormat(["2026-01-02", "2026-03-04"]);
    expect(detection.format).toBe("YYYY-MM-DD");
    expect(detection.confident).toBe(true);
  });

  it("requires a format to read every sample", () => {
    // 13/01 rules out month-first; 01/13 would rule out day-first. Together
    // no single format reads the column.
    const detection = detectDateFormat(["13/01/2026", "01/13/2026"]);
    expect(detection.candidates).toEqual([]);
    expect(detection.confident).toBe(false);
    expect(detection.unparsed).toEqual([]);
  });

  it("is not derailed by one impossible value in an otherwise clean column", () => {
    // 31/02 exists in no format. It must not disqualify DD/MM for the rest of
    // the column — otherwise one typo silently reinterprets every other row.
    const detection = detectDateFormat([
      "25/12/2026",
      "31/02/2026",
      "01/08/2026",
      "14/08/2026",
      "03/08/2026",
    ]);
    expect(detection.format).toBe("DD/MM/YYYY");
    expect(detection.confident).toBe(true);
    expect(detection.unparsed).toEqual(["31/02/2026"]);
  });

  it("still rejects a format that reads only half the column", () => {
    const detection = detectDateFormat(["13/01/2026", "01/13/2026"]);
    expect(detection.candidates).toEqual([]);
  });

  it("reports values no format can read", () => {
    const detection = detectDateFormat(["2026-01-02", "PENDING"]);
    expect(detection.candidates).toEqual([]);
    expect(detection.unparsed).toEqual(["PENDING"]);
  });

  it("handles an empty column", () => {
    const detection = detectDateFormat([]);
    expect(detection.confident).toBe(false);
    expect(detection.candidates).toEqual([]);
  });

  it("ignores blank cells", () => {
    const detection = detectDateFormat(["", "  ", "25/12/2026"]);
    expect(detection.format).toBe("DD/MM/YYYY");
    expect(detection.confident).toBe(true);
  });

  it("detects named-month formats", () => {
    expect(detectDateFormat(["14-Aug-2026", "01-Jan-2026"]).format).toBe("DD-MMM-YYYY");
    expect(detectDateFormat(["Aug 14, 2026", "Jan 1, 2026"]).format).toBe("MMM DD, YYYY");
  });
});

describe("column parsing", () => {
  it("parses a whole column consistently", () => {
    const { dates, detection } = parseDateColumn(["01/02/2026", "25/12/2026", "03/04/2026"]);
    expect(detection.format).toBe("DD/MM/YYYY");
    expect(dates).toEqual(["2026-02-01", "2026-12-25", "2026-04-03"]);
  });

  it("returns null for blanks and unreadable values", () => {
    const { dates } = parseDateColumn(["2026-01-01", "", "PENDING"]);
    expect(dates).toEqual(["2026-01-01", null, null]);
  });

  it("never mixes formats within one column", () => {
    // The whole point: one bad row must not flip the interpretation of others.
    const { dates } = parseDateColumn(["01/02/2026", "02/03/2026", "25/12/2026"]);
    expect(dates).toEqual(["2026-02-01", "2026-03-02", "2026-12-25"]);
  });

  it("round-trips any date through any format it can express", () => {
    const formatArb = fc.constantFrom(...DATE_FORMATS);
    fc.assert(
      fc.property(
        fc.integer({ min: 2000, max: 2099 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        formatArb,
        (year, month, day, format) => {
          const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const rendered = render(year, month, day, format);
          expect(parseDateIn(rendered, format)).toBe(iso);
        },
      ),
      { numRuns: 300 },
    );
  });
});

function render(year: number, month: number, day: number, format: string): string {
  const dd = String(day).padStart(2, "0");
  const mm = String(month).padStart(2, "0");
  const mmm = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
    month - 1
  ] as string;
  switch (format) {
    case "YYYY-MM-DD":
      return `${year}-${mm}-${dd}`;
    case "YYYY/MM/DD":
      return `${year}/${mm}/${dd}`;
    case "DD/MM/YYYY":
      return `${dd}/${mm}/${year}`;
    case "MM/DD/YYYY":
      return `${mm}/${dd}/${year}`;
    case "DD-MM-YYYY":
      return `${dd}-${mm}-${year}`;
    case "MM-DD-YYYY":
      return `${mm}-${dd}-${year}`;
    case "DD.MM.YYYY":
      return `${dd}.${mm}.${year}`;
    case "DD-MMM-YYYY":
      return `${dd}-${mmm}-${year}`;
    case "MMM DD, YYYY":
      return `${mmm} ${dd}, ${year}`;
    default:
      throw new Error(`unhandled ${format}`);
  }
}
