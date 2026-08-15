import { describe, it, expect } from "vitest";
import {
  tokenise,
  levenshtein,
  levenshteinRatio,
  jaro,
  jaroWinkler,
  isReferenceToken,
  referenceTokens,
  sharedReferences,
  tokenOverlap,
  similarityBreakdown,
  descriptionSimilarity,
} from "../src/reconcile/similarity.js";

describe("tokenise", () => {
  it("uppercases and splits on anything that is not alphanumeric", () => {
    expect(tokenise("FPI ACME LTD — INV1001")).toEqual(["FPI", "ACME", "LTD", "INV1001"]);
    expect(tokenise("dd rent, august 08")).toEqual(["DD", "RENT", "AUGUST", "08"]);
    expect(tokenise("SQ *SETTLEMENT/0805")).toEqual(["SQ", "SETTLEMENT", "0805"]);
  });

  it("drops empty runs at both ends", () => {
    expect(tokenise("  ---  ")).toEqual([]);
    expect(tokenise("")).toEqual([]);
    expect(tokenise("!!!ACME!!!")).toEqual(["ACME"]);
  });
});

describe("levenshtein", () => {
  const cases: [string, string, number][] = [
    ["", "", 0],
    ["a", "", 1],
    ["", "abc", 3],
    ["abc", "abc", 0],
    ["kitten", "sitting", 3],
    ["flaw", "lawn", 2],
    ["saturday", "sunday", 3],
    ["RENT", "RANT", 1],
    ["ACME LTD", "ACME LIMITED", 4],
    ["INV1001", "INV1002", 1],
  ];

  for (const [a, b, expected] of cases) {
    it(`"${a}" vs "${b}" is ${expected}`, () => {
      expect(levenshtein(a, b)).toBe(expected);
      expect(levenshtein(b, a)).toBe(expected);
    });
  }

  it("is symmetric and non-negative on random pairs", () => {
    let seed = 991;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const letters = "ABCDE";
    const word = (n: number) =>
      Array.from({ length: n }, () => letters[Math.floor(rnd() * letters.length)]).join("");

    for (let i = 0; i < 2000; i++) {
      const a = word(Math.floor(rnd() * 8));
      const b = word(Math.floor(rnd() * 8));
      const d = levenshtein(a, b);
      expect(d).toBe(levenshtein(b, a));
      expect(d).toBeGreaterThanOrEqual(Math.abs(a.length - b.length));
      expect(d).toBeLessThanOrEqual(Math.max(a.length, b.length));
    }
  });

  it("obeys the triangle inequality", () => {
    const words = ["ACME", "ACNE", "ACME LTD", "RENT", "RENTAL", "", "AC"];
    for (const a of words) {
      for (const b of words) {
        for (const c of words) {
          expect(levenshtein(a, c)).toBeLessThanOrEqual(levenshtein(a, b) + levenshtein(b, c));
        }
      }
    }
  });

  it("stops early once the ceiling is passed, reporting ceiling + 1", () => {
    expect(levenshtein("kitten", "sitting", 2)).toBe(3);
    expect(levenshtein("kitten", "sitting", 3)).toBe(3);
    expect(levenshtein("abcdefgh", "", 2)).toBe(3);
    // Under the ceiling the exact distance still comes back.
    expect(levenshtein("INV1001", "INV1002", 4)).toBe(1);
  });

  it("ratio is 1 for identical strings and 0 for fully disjoint ones", () => {
    expect(levenshteinRatio("", "")).toBe(1);
    expect(levenshteinRatio("ACME", "ACME")).toBe(1);
    expect(levenshteinRatio("ABCD", "WXYZ")).toBe(0);
    expect(levenshteinRatio("INV1001", "INV1002")).toBeCloseTo(6 / 7, 10);
  });
});

describe("jaro and jaro-winkler", () => {
  it("reproduces the published worked examples", () => {
    expect(jaro("MARTHA", "MARHTA")).toBeCloseTo(0.944444, 5);
    expect(jaro("DIXON", "DICKSONX")).toBeCloseTo(0.766667, 5);
    expect(jaro("JELLYFISH", "SMELLYFISH")).toBeCloseTo(0.896296, 5);
    expect(jaroWinkler("MARTHA", "MARHTA")).toBeCloseTo(0.961111, 5);
    expect(jaroWinkler("DIXON", "DICKSONX")).toBeCloseTo(0.813333, 5);
  });

  it("is 1 only for identical strings and 0 when nothing matches", () => {
    expect(jaro("ACME", "ACME")).toBe(1);
    expect(jaroWinkler("ACME", "ACME")).toBe(1);
    expect(jaro("ABC", "XYZ")).toBe(0);
    expect(jaroWinkler("ABC", "XYZ")).toBe(0);
    expect(jaro("", "ABC")).toBe(0);
    expect(jaro("", "")).toBe(1);
  });

  it("never scores below plain jaro and stays inside 0..1", () => {
    const words = ["RENT", "RENTAL", "ACME LTD", "ACME LIMITED", "PAYROLL", "PAYE", ""];
    for (const a of words) {
      for (const b of words) {
        const j = jaro(a, b);
        const jw = jaroWinkler(a, b);
        expect(jw).toBeGreaterThanOrEqual(j - 1e-12);
        expect(jw).toBeLessThanOrEqual(1 + 1e-12);
      }
    }
  });

  it("rewards a shared prefix, which is where bank descriptors agree", () => {
    expect(jaroWinkler("TOOLCHAIN LTD", "TOOLCHAIN LIMITED")).toBeGreaterThan(
      jaroWinkler("TOOLCHAIN LTD", "LIMITED TOOLCHAIN"),
    );
  });
});

describe("reference tokens", () => {
  it("recognises mixed letter-digit ids and long digit runs", () => {
    expect(isReferenceToken("INV1001")).toBe(true);
    expect(isReferenceToken("SUB9931")).toBe(true);
    expect(isReferenceToken("1001")).toBe(true);
    expect(isReferenceToken("A1")).toBe(false);
    expect(isReferenceToken("08")).toBe(false);
    expect(isReferenceToken("805")).toBe(false);
    expect(isReferenceToken("ACME")).toBe(false);
    expect(isReferenceToken("")).toBe(false);
  });

  it("pulls references out of a full descriptor", () => {
    expect(referenceTokens("FPI ACME LTD — INV1001")).toEqual(["INV1001"]);
    expect(referenceTokens("PAYROLL AUGUST")).toEqual([]);
    expect(referenceTokens("SQ *SETTLEMENT 0805 4471")).toEqual(["0805", "4471"]);
  });

  it("matches a bare number against a prefixed one", () => {
    expect(sharedReferences("FPI ACME LTD INV1001", "Invoice 1001 settled")).toEqual(["1001"]);
    expect(sharedReferences("TOOLCHAIN LTD SUB9931", "Annual licence SUB9931")).toEqual(["SUB9931"]);
  });

  it("does not match on unrelated ids", () => {
    expect(sharedReferences("INV1001", "INV2002")).toEqual([]);
    expect(sharedReferences("PAYROLL AUGUST", "RENT AUGUST")).toEqual([]);
    // A two-digit tail is too weak to count as agreement.
    expect(sharedReferences("REF 1001", "REF 2001")).toEqual([]);
  });

  it("is symmetric", () => {
    const pairs: [string, string][] = [
      ["FPI ACME LTD INV1001", "Invoice 1001 settled"],
      ["SUB9931", "SUB9931 renewal"],
      ["nothing here", "or here"],
    ];
    for (const [a, b] of pairs) {
      expect(sharedReferences(a, b)).toEqual(sharedReferences(b, a));
    }
  });
});

describe("tokenOverlap", () => {
  it("is 1 only when the two token sets agree entirely", () => {
    expect(tokenOverlap(["ACME", "LTD"], ["ACME", "LTD"])).toBeCloseTo(1, 10);
    expect(tokenOverlap(["ACME"], ["ACME"])).toBeCloseTo(1, 10);
  });

  it("scores containment as the partial agreement it is", () => {
    const contained = tokenOverlap(["ACME"], ["ACME", "LTD", "PAYMENT"]);
    expect(contained).toBeGreaterThan(0.3);
    expect(contained).toBeLessThan(0.6);
    // Padding the long side further dilutes the agreement.
    expect(tokenOverlap(["ACME"], ["ACME", "LTD", "PAYMENT", "REFERENCE"])).toBeLessThan(contained);
  });

  it("is symmetric under argument order, including on equal-length sides", () => {
    const pairs: [string[], string[]][] = [
      [["ACME", "LTD"], ["ACME", "LIMITED"]],
      [["RENT", "AUGUST"], ["AUGUST", "RENT"]],
      [["PAYROLL"], ["PAYE", "NI", "HMRC"]],
      [["SALARIES"], ["SALARY"]],
    ];
    for (const [a, b] of pairs) {
      expect(tokenOverlap(a, b)).toBeCloseTo(tokenOverlap(b, a), 12);
    }
  });

  it("is 0 for disjoint token sets and for empty input", () => {
    expect(tokenOverlap(["ACME"], ["ZZZZ"])).toBe(0);
    expect(tokenOverlap([], ["ACME"])).toBe(0);
    expect(tokenOverlap(["ACME"], [])).toBe(0);
  });

  it("does not let one token on the long side satisfy two on the short side", () => {
    const both = tokenOverlap(["RENT", "RENT"], ["RENT"]);
    expect(both).toBeGreaterThan(0.4);
    expect(both).toBeLessThan(0.75);
  });

  it("weights long tokens above filler words", () => {
    const contentWord = tokenOverlap(["TOOLCHAIN", "LTD"], ["TOOLCHAIN", "ZZ"]);
    const fillerWord = tokenOverlap(["TOOLCHAIN", "LTD"], ["ZZZZZZZZZ", "LTD"]);
    expect(contentWord).toBeGreaterThan(fillerWord);
  });

  it("survives reordering", () => {
    expect(tokenOverlap(["ACME", "LTD", "INV1001"], ["INV1001", "LTD", "ACME"])).toBeCloseTo(1, 10);
  });
});

describe("similarityBreakdown", () => {
  it("scores the same transaction seen from both sides highly", () => {
    const result = similarityBreakdown("FPI ACME LTD — INV1001", "Invoice 1001 settled");
    expect(result.sharedReferences).toEqual(["1001"]);
    expect(result.score).toBeGreaterThanOrEqual(0.9);
  });

  it("keeps two different months apart", () => {
    const august = similarityBreakdown("DD RENT, AUGUST 08", "August rent");
    const july = similarityBreakdown("DD RENT, AUGUST 08", "July rent");
    expect(august.score).toBeGreaterThan(july.score);
  });

  it("reports the tokens the two sides share", () => {
    const result = similarityBreakdown("PAYROLL AUGUST", "August payroll run");
    expect(result.sharedTokens).toEqual(["AUGUST", "PAYROLL"]);
    expect(result.score).toBeGreaterThan(0.7);
  });

  it("is 0 when either side has no tokens at all", () => {
    expect(similarityBreakdown("", "ACME").score).toBe(0);
    expect(similarityBreakdown("ACME", "   ").score).toBe(0);
    expect(similarityBreakdown("", "").score).toBe(0);
  });

  it("stays inside 0..1 and is symmetric on a spread of real descriptors", () => {
    const descriptors = [
      "BGC SHARE CAPITAL",
      "Opening share capital",
      "DD RENT, AUGUST 08",
      "August rent",
      "SQ *SETTLEMENT 0805 4471",
      "Processor settlement for 5 Aug",
      "TOOLCHAIN LTD SUB9931",
      "Annual toolchain licence, split by project",
      "PAYROLL AUGUST",
      "August payroll",
      "HMRC PAYE NI",
      "ATM CASH WITHDRAWAL 200000",
      "",
    ];
    for (const a of descriptors) {
      for (const b of descriptors) {
        const forward = descriptionSimilarity(a, b);
        const backward = descriptionSimilarity(b, a);
        expect(forward).toBeGreaterThanOrEqual(0);
        expect(forward).toBeLessThanOrEqual(1);
        expect(forward).toBeCloseTo(backward, 9);
      }
    }
  });

  it("scores a string against itself at the top of the range", () => {
    for (const text of ["ACME LTD", "PAYROLL AUGUST", "TOOLCHAIN LTD SUB9931"]) {
      expect(descriptionSimilarity(text, text)).toBeCloseTo(1, 10);
    }
  });
});
