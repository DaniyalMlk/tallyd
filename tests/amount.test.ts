import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  AmountParseError,
  combineDebitCredit,
  detectDecimalConvention,
  looksLikeAmount,
  normaliseAmount,
  parseAmount,
} from "../src/statement/amount.js";
import { GBP, Money } from "../src/money/index.js";

describe("normalisation, dot convention", () => {
  it.each([
    ["1234.56", "1234.56"],
    ["1,234.56", "1234.56"],
    ["-1,234.56", "-1234.56"],
    ["+1,234.56", "1234.56"],
    ["(1,234.56)", "-1234.56"],
    ["£1,234.56", "1234.56"],
    ["$1,234.56", "1234.56"],
    ["1,234.56 GBP", "1234.56"],
    ["1234.56-", "-1234.56"],
    ["1,234.56 DR", "-1234.56"],
    ["1,234.56 CR", "1234.56"],
    ["1234.56CR", "1234.56"],
    ["1 234.56", "1234.56"],
    ["1'234.56", "1234.56"],
    ["0.00", "0.00"],
    [".50", "0.50"],
    ["1234", "1234"],
    ["  42.00  ", "42.00"],
  ])("reads %s as %s", (input, expected) => {
    expect(normaliseAmount(input, "dot")).toBe(expected);
  });

  it("treats a negative in parentheses with a minus as still negative", () => {
    // "(-45.00)" is a double marker; it should not cancel to positive.
    expect(normaliseAmount("(-45.00)", "dot")).toBe("45.00");
  });
});

describe("normalisation, comma convention", () => {
  it.each([
    ["1234,56", "1234.56"],
    ["1.234,56", "1234.56"],
    ["-1.234,56", "-1234.56"],
    ["1.234.567,89", "1234567.89"],
    ["1.234,56-", "-1234.56"],
    ["€1.234,56", "1234.56"],
    ["0,00", "0.00"],
  ])("reads %s as %s", (input, expected) => {
    expect(normaliseAmount(input, "comma")).toBe(expected);
  });
});

describe("rejections", () => {
  it.each(["", "   ", "abc", "12abc", "--", "£", "1.2.3"])("rejects %s", (input) => {
    expect(() => normaliseAmount(input, "dot")).toThrow(AmountParseError);
  });

  it("names the input in the message", () => {
    expect(() => normaliseAmount("wat", "dot")).toThrow(/"wat"/);
  });

  it("reports what looks like an amount", () => {
    expect(looksLikeAmount("1,234.56")).toBe(true);
    expect(looksLikeAmount("(45.00)")).toBe(true);
    expect(looksLikeAmount("CARD PAYMENT")).toBe(false);
    expect(looksLikeAmount("")).toBe(false);
    expect(looksLikeAmount("2026-01-01")).toBe(false);
  });
});

describe("decimal convention detection", () => {
  it("uses the rightmost separator when both appear", () => {
    expect(detectDecimalConvention(["1,234.56"])).toEqual({ convention: "dot", confident: true });
    expect(detectDecimalConvention(["1.234,56"])).toEqual({
      convention: "comma",
      confident: true,
    });
  });

  it("reads a repeated separator as grouping", () => {
    expect(detectDecimalConvention(["1.234.567"]).convention).toBe("comma");
    expect(detectDecimalConvention(["1,234,567"]).convention).toBe("dot");
  });

  it("uses a two-digit tail as decisive evidence", () => {
    expect(detectDecimalConvention(["42.15", "18.99"]).convention).toBe("dot");
    expect(detectDecimalConvention(["42,15", "18,99"]).convention).toBe("comma");
  });

  it("decides a whole Dutch column correctly", () => {
    const column = ["-42,15", "2.500,00", "-1.200,00", "83,10"];
    expect(detectDecimalConvention(column)).toEqual({ convention: "comma", confident: true });
  });

  it("decides a whole UK column correctly", () => {
    const column = ["-42.15", "2,500.00", "-1,200.00", "83.10"];
    expect(detectDecimalConvention(column)).toEqual({ convention: "dot", confident: true });
  });

  it("admits when it has no evidence", () => {
    expect(detectDecimalConvention(["100", "250", "1000"])).toEqual({
      convention: "dot",
      confident: false,
    });
    expect(detectDecimalConvention([])).toEqual({ convention: "dot", confident: false });
  });

  it("lets one decisive value settle an otherwise ambiguous column", () => {
    // Every value reads either way except the last, which cannot be grouping.
    const column = ["1,234", "5,678", "9,1"];
    expect(detectDecimalConvention(column)).toEqual({ convention: "comma", confident: true });
  });

  it("ignores values it cannot read at all", () => {
    expect(detectDecimalConvention(["n/a", "PENDING", "42.15"]).convention).toBe("dot");
  });
});

describe("parseAmount", () => {
  it("produces Money", () => {
    expect(parseAmount("1,234.56", GBP).toDecimalString()).toBe("1234.56");
    expect(parseAmount("(45.00)", GBP).toDecimalString()).toBe("-45.00");
  });

  it("respects the convention", () => {
    expect(parseAmount("1.234,56", GBP, { convention: "comma" }).toDecimalString()).toBe(
      "1234.56",
    );
  });

  it("rejects excess precision unless rounding is requested", () => {
    expect(() => parseAmount("1.005", GBP)).toThrow();
    expect(parseAmount("1.005", GBP, { rounding: "half-up" }).toDecimalString()).toBe("1.01");
  });

  it("round-trips any Money through its formatted form", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }), (minor) => {
        const original = Money.ofMinor(minor, GBP);
        const formatted = original.format(); // "£1,234.56"
        expect(parseAmount(formatted, GBP).equals(original)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

describe("debit and credit columns", () => {
  it("makes a debit negative and a credit positive", () => {
    expect(combineDebitCredit("950.00", "", GBP).toDecimalString()).toBe("-950.00");
    expect(combineDebitCredit("", "1200.00", GBP).toDecimalString()).toBe("1200.00");
  });

  it("ignores a zero in the other column", () => {
    expect(combineDebitCredit("950.00", "0.00", GBP).toDecimalString()).toBe("-950.00");
    expect(combineDebitCredit("0.00", "1200.00", GBP).toDecimalString()).toBe("1200.00");
  });

  it("ignores a sign already present in the debit column", () => {
    expect(combineDebitCredit("-950.00", "", GBP).toDecimalString()).toBe("-950.00");
  });

  it("refuses to guess when both columns carry a value", () => {
    expect(() => combineDebitCredit("10.00", "20.00", GBP)).toThrow(/both debit and credit/);
  });

  it("refuses when both are empty", () => {
    expect(() => combineDebitCredit("", "  ", GBP)).toThrow(/both debit and credit/);
  });

  it("allows a genuine zero line", () => {
    expect(combineDebitCredit("0.00", "0.00", GBP).isZero).toBe(true);
  });
});
