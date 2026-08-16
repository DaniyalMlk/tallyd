import { describe, expect, it } from "vitest";
import { measureAccuracy, renderAccuracy, type TruthLink } from "../src/reconcile/accuracy.js";
import type { Match, ReconciliationResult } from "../src/reconcile/matcher.js";
import type { ScoredMatch } from "../src/reconcile/scoring.js";
import { generateBooks } from "../src/demo/generator.js";
import { bankView } from "../src/reconcile/bankView.js";
import { reconcile } from "../src/reconcile/matcher.js";

const scored = (score: number): ScoredMatch =>
  ({ score, confidence: "high", reasons: [], rejectedBy: null, dayGap: 0, amountGap: 0n }) as ScoredMatch;

const match = (bookIds: readonly string[], statementIds: readonly string[], score = 0.9): Match =>
  ({
    book: bookIds.map((id) => ({ id })),
    statement: statementIds.map((id) => ({ id })),
    kind: bookIds.length > 1 ? "one-to-many" : "one-to-one",
    scored: scored(score),
  }) as unknown as Match;

const result = (matched: readonly Match[], suggested: readonly Match[] = []): ReconciliationResult =>
  ({ matched, suggested }) as unknown as ReconciliationResult;

describe("measureAccuracy on hand-built cases", () => {
  const truth: readonly TruthLink[] = [
    { statementId: "S1", bookIds: ["B1"] },
    { statementId: "S2", bookIds: ["B2"] },
    { statementId: "S3", bookIds: ["B3", "B4"] },
  ];

  it("gives a perfect score to a perfect reconciliation", () => {
    const report = measureAccuracy(
      result([match(["B1"], ["S1"]), match(["B2"], ["S2"]), match(["B3", "B4"], ["S3"])]),
      truth,
    );
    expect(report.correct).toBe(3);
    expect(report.wrong).toBe(0);
    expect(report.missed).toBe(0);
    expect(report.precision).toBe(1);
    expect(report.recall).toBe(1);
    expect(report.f1).toBe(1);
  });

  it("does not care about the order of lines within a match", () => {
    const report = measureAccuracy(result([match(["B4", "B3"], ["S3"])]), truth);
    expect(report.correct).toBe(1);
  });

  it("counts a partial group as wrong, not as partly right", () => {
    const report = measureAccuracy(result([match(["B3"], ["S3"])]), truth);
    expect(report.correct).toBe(0);
    expect(report.wrong).toBe(1);
    expect(report.failures[0]?.reason).toBe("paired the wrong lines");
  });

  it("flags a match over lines the truth says nothing about", () => {
    const report = measureAccuracy(result([match(["B9"], ["S9"])]), truth);
    expect(report.wrong).toBe(1);
    expect(report.failures[0]?.reason).toBe("no truth for these lines");
    expect(report.failures[0]?.statementIds).toEqual(["S9"]);
  });

  it("counts a link that was neither matched nor suggested as missed", () => {
    const report = measureAccuracy(result([match(["B1"], ["S1"])]), truth);
    expect(report.correct).toBe(1);
    expect(report.missed).toBe(2);
    expect(report.recall).toBeCloseTo(1 / 3, 10);
  });

  it("keeps suggestions out of precision and recall", () => {
    const report = measureAccuracy(
      result([match(["B1"], ["S1"])], [match(["B2"], ["S2"]), match(["B9"], ["S3"])]),
      truth,
    );
    expect(report.precision).toBe(1);
    expect(report.recall).toBeCloseTo(1 / 3, 10);
    expect(report.suggestedCorrect).toBe(1);
    expect(report.suggestedWrong).toBe(1);
  });

  it("counts a correct suggestion as found for recall-with-suggestions", () => {
    const report = measureAccuracy(
      result([match(["B1"], ["S1"])], [match(["B2"], ["S2"])]),
      truth,
    );
    expect(report.recallWithSuggestions).toBeCloseTo(2 / 3, 10);
    expect(report.missed).toBe(1);
  });

  it("does not double-count a link matched and suggested at once", () => {
    const report = measureAccuracy(
      result([match(["B1"], ["S1"])], [match(["B1"], ["S1"])]),
      truth,
    );
    expect(report.recallWithSuggestions).toBeCloseTo(1 / 3, 10);
  });

  it("treats an empty truth as vacuously satisfied", () => {
    const report = measureAccuracy(result([]), []);
    expect(report.precision).toBe(1);
    expect(report.recall).toBe(1);
    expect(report.expected).toBe(0);
  });

  it("gives precision 1 and recall 0 when the engine commits to nothing", () => {
    const report = measureAccuracy(result([]), truth);
    expect(report.precision).toBe(1);
    expect(report.recall).toBe(0);
    expect(report.f1).toBe(0);
  });

  it("merges truth links that share a book line into one many-to-one group", () => {
    const shared: readonly TruthLink[] = [
      { statementId: "S1", bookIds: ["B1"] },
      { statementId: "S2", bookIds: ["B1"] },
    ];
    const report = measureAccuracy(result([match(["B1"], ["S1", "S2"])]), shared);
    expect(report.expected).toBe(1);
    expect(report.correct).toBe(1);
  });

  it("renders a line a human can read", () => {
    const text = renderAccuracy(measureAccuracy(result([match(["B1"], ["S1"])]), truth));
    expect(text).toContain("expected 3");
    expect(text).toContain("precision 100.0%");
    expect(text).toContain("F1");
  });
});

describe("measureAccuracy against the generator", () => {
  it("finds most of a generated month without inventing matches", () => {
    const generated = generateBooks({ seed: 101, months: 2, invoicesPerMonth: 10 });
    const books = bankView(generated.ledger, generated.bankAccount);
    const report = measureAccuracy(reconcile(books, generated.statement), generated.truth);

    expect(report.expected).toBeGreaterThan(30);
    // The bar that matters: an auto-accepted match must be right. A wrong one
    // consumes evidence and strands the two lines it should have paired.
    expect(report.precision).toBe(1);
    expect(report.wrong).toBe(0);
    // Two thirds go straight through; most of the rest reach the review queue
    // rather than being lost, which is the conservative behaviour the score
    // thresholds are chosen for.
    expect(report.recall).toBeGreaterThan(0.6);
    expect(report.recallWithSuggestions).toBeGreaterThan(0.9);
  });

  it("holds up across several seeds", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const generated = generateBooks({ seed, months: 2, invoicesPerMonth: 8 });
      const books = bankView(generated.ledger, generated.bankAccount);
      const report = measureAccuracy(reconcile(books, generated.statement), generated.truth);
      expect(report.precision).toBe(1);
      expect(report.recallWithSuggestions).toBeGreaterThan(0.8);
    }
  });
});
