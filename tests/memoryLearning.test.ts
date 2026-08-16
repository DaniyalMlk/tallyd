import { describe, expect, it } from "vitest";
import { generateBooks } from "../src/demo/generator.js";
import { bankView } from "../src/reconcile/bankView.js";
import { reconcile, type Match } from "../src/reconcile/matcher.js";
import { measureAccuracy } from "../src/reconcile/accuracy.js";
import { MatchMemory, type Decision } from "../src/reconcile/memory.js";
import type { CalendarDate } from "../src/ledger/date.js";

/**
 * What a reviewer working through a queue produces: one decision per pair they
 * looked at, right or wrong. Correct pairings are accepted and incorrect ones
 * refused, which is the optimistic-but-fair assumption — a reviewer who cannot
 * tell their own suppliers apart is not a problem memory can fix.
 */
function decisionsFrom(
  matches: readonly Match[],
  truth: readonly { statementId: string; bookIds: readonly string[] }[],
  on: CalendarDate,
): Decision[] {
  const expected = new Map(truth.map((link) => [link.statementId, [...link.bookIds].sort().join("+")]));

  return matches
    .filter((match) => match.statement.length === 1 && match.book.length === 1)
    .map((match) => {
      const statement = match.statement[0];
      const entry = match.book[0];
      if (statement === undefined || entry === undefined) throw new Error("empty match");
      return {
        statementDescription: statement.description,
        bookDescription: entry.description,
        accepted: expected.get(statement.id) === entry.id,
        on,
      };
    });
}

/** Reconcile one window of a generated dataset. */
function window(
  seed: number,
  months: number,
  invoicesPerMonth: number,
  start: string,
  memory?: MatchMemory,
) {
  const generated = generateBooks({ seed, months, invoicesPerMonth, start });
  const books = bankView(generated.ledger, generated.bankAccount);
  const result = reconcile(books, generated.statement, memory === undefined ? {} : { memory });
  return { generated, result, accuracy: measureAccuracy(result, generated.truth) };
}

describe("memory learnt from one period helps in the next", () => {
  // The two periods are different books from the same business: different
  // seeds, so the transactions are unrelated, but the same cast of customers
  // and suppliers, which is exactly the situation memory is for.
  const TRAIN = { seed: 5, months: 4, invoices: 12, start: "2026-01-01" };
  const TEST = { seed: 6, months: 4, invoices: 12, start: "2027-01-01" };

  const trained = (): MatchMemory => {
    const first = window(TRAIN.seed, TRAIN.months, TRAIN.invoices, TRAIN.start);
    const decisions = [
      ...decisionsFrom(first.result.matched, first.generated.truth, first.generated.to),
      ...decisionsFrom(first.result.suggested, first.generated.truth, first.generated.to),
    ];
    return MatchMemory.from(decisions);
  };

  it("learns something from a period's review queue", () => {
    const memory = trained();
    expect(memory.size).toBeGreaterThan(5);
  });

  it("moves work out of the review queue in the following period", () => {
    const memory = trained();
    const cold = window(TEST.seed, TEST.months, TEST.invoices, TEST.start);
    const warm = window(TEST.seed, TEST.months, TEST.invoices, TEST.start, memory);

    // The measurement that matters: more went through unattended.
    expect(warm.accuracy.correct).toBeGreaterThan(cold.accuracy.correct);
    expect(warm.result.suggested.length).toBeLessThan(cold.result.suggested.length);
  });

  it("does not buy the improvement with wrong matches", () => {
    const memory = trained();
    const cold = window(TEST.seed, TEST.months, TEST.invoices, TEST.start);
    const warm = window(TEST.seed, TEST.months, TEST.invoices, TEST.start, memory);

    // Precision is the whole game. Auto-accepting more is only an improvement
    // if the extra ones are right.
    expect(cold.accuracy.precision).toBe(1);
    expect(warm.accuracy.precision).toBe(1);
    expect(warm.accuracy.wrong).toBe(0);
  });

  it("does not lose anything it used to find", () => {
    const memory = trained();
    const cold = window(TEST.seed, TEST.months, TEST.invoices, TEST.start);
    const warm = window(TEST.seed, TEST.months, TEST.invoices, TEST.start, memory);
    expect(warm.accuracy.recallWithSuggestions).toBeGreaterThanOrEqual(
      cold.accuracy.recallWithSuggestions,
    );
  });

  it("holds across several pairs of periods", () => {
    const pairs: readonly (readonly [number, number])[] = [
      [11, 12],
      [21, 22],
      [31, 32],
    ];
    for (const [trainSeed, testSeed] of pairs) {
      const first = window(trainSeed, 3, 10, "2026-01-01");
      const memory = MatchMemory.from([
        ...decisionsFrom(first.result.matched, first.generated.truth, first.generated.to),
        ...decisionsFrom(first.result.suggested, first.generated.truth, first.generated.to),
      ]);

      const cold = window(testSeed, 3, 10, "2027-01-01");
      const warm = window(testSeed, 3, 10, "2027-01-01", memory);

      expect(warm.accuracy.precision).toBe(1);
      expect(warm.accuracy.recall).toBeGreaterThanOrEqual(cold.accuracy.recall);
    }
  });
});

describe("a memory of nothing changes nothing", () => {
  it("reconciles identically to no memory at all", () => {
    const cold = window(9, 3, 10, "2026-01-01");
    const empty = window(9, 3, 10, "2026-01-01", MatchMemory.empty());

    expect(empty.result.matched.length).toBe(cold.result.matched.length);
    expect(empty.result.suggested.map((m) => m.scored.score)).toEqual(
      cold.result.suggested.map((m) => m.scored.score),
    );
  });
});

describe("a memory full of mistakes does not wreck a reconciliation", () => {
  it("survives every decision being the wrong way round", () => {
    // Someone accepted everything the matcher offered without looking, wrong
    // ones included, and refused the right ones. The gates still hold, so the
    // damage is bounded: the queue gets longer, not dishonest.
    const first = window(5, 3, 10, "2026-01-01");
    const inverted = MatchMemory.from(
      decisionsFrom(first.result.matched, first.generated.truth, first.generated.to).map(
        (decision) => ({ ...decision, accepted: !decision.accepted }),
      ),
    );

    const warm = window(6, 3, 10, "2027-01-01", inverted);
    expect(warm.accuracy.wrong).toBe(0);
    expect(warm.accuracy.precision).toBe(1);
  });
});
