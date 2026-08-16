import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { CandidateIndex, candidatePairs } from "../src/reconcile/candidates.js";
import { Money } from "../src/money/money.js";
import { GBP, USD } from "../src/money/currency.js";
import { date } from "../src/ledger/date.js";
import { statementLine, type StatementLine } from "../src/statement/line.js";
import type { BookLine } from "../src/reconcile/bankView.js";
import { scorePair } from "../src/reconcile/scoring.js";
import { generateBooks } from "../src/demo/generator.js";
import { bankView } from "../src/reconcile/bankView.js";

const book = (id: string, day: string, minor: number, currency = GBP): BookLine =>
  ({
    id,
    entryId: id,
    postingIndex: 0,
    date: date(day),
    account: "1110",
    amount: Money.ofMinor(BigInt(minor), currency),
    description: id,
    normalisedDescription: id.toUpperCase(),
    reference: null,
    contraAccounts: [],
    reverses: null,
    reversedBy: null,
    tags: [],
  }) as BookLine;

const line = (id: string, day: string, minor: number, currency = GBP): StatementLine =>
  statementLine({
    id,
    date: date(day),
    description: id,
    amount: Money.ofMinor(BigInt(minor), currency),
    sourceRow: 0,
  });

describe("the candidate index finds the right lines", () => {
  const books = [
    book("A", "2026-03-10", 5000),
    book("B", "2026-03-12", 5000),
    book("C", "2026-03-20", 5000),
    book("D", "2026-03-12", -5000),
    book("E", "2026-03-12", 7500),
  ];
  const index = new CandidateIndex(books);

  it("matches on the exact amount and the date window", () => {
    expect(index.candidatesFor(line("S", "2026-03-12", 5000), 0n, 3)).toEqual([0, 1]);
  });

  it("widens with the window", () => {
    expect(index.candidatesFor(line("S", "2026-03-12", 5000), 0n, 10)).toEqual([0, 1, 2]);
  });

  it("finds only the same day at a zero window", () => {
    expect(index.candidatesFor(line("S", "2026-03-12", 5000), 0n, 0)).toEqual([1]);
  });

  it("does not cross the sign", () => {
    expect(index.candidatesFor(line("S", "2026-03-12", -5000), 0n, 30)).toEqual([3]);
  });

  it("finds nothing for an amount nobody has", () => {
    expect(index.candidatesFor(line("S", "2026-03-12", 1234), 0n, 30)).toEqual([]);
  });

  it("finds nothing for a currency nobody uses", () => {
    expect(index.candidatesFor(line("S", "2026-03-12", 5000, USD), 0n, 30)).toEqual([]);
  });

  it("reaches a nearby amount once a tolerance is allowed", () => {
    expect(index.candidatesFor(line("S", "2026-03-12", 5010), 20n, 5)).toEqual([0, 1]);
  });

  it("does not reach past the tolerance", () => {
    expect(index.candidatesFor(line("S", "2026-03-12", 5010), 5n, 5)).toEqual([]);
  });

  it("takes a negative tolerance to mean its magnitude", () => {
    expect(index.candidatesFor(line("S", "2026-03-12", 5010), -20n, 5)).toEqual([0, 1]);
  });

  it("still refuses to cross the sign under a wide tolerance", () => {
    // 10000 minor units of tolerance spans both +50.00 and -50.00.
    const found = index.candidatesFor(line("S", "2026-03-12", 5000), 10000n, 5);
    expect(found).not.toContain(3);
  });

  it("returns indices in ascending order", () => {
    const shuffled = new CandidateIndex([
      book("C", "2026-03-20", 5000),
      book("A", "2026-03-10", 5000),
      book("B", "2026-03-12", 5000),
    ]);
    expect(shuffled.candidatesFor(line("S", "2026-03-15", 5000), 0n, 30)).toEqual([0, 1, 2]);
  });

  it("reports what it built", () => {
    expect(index.stats.lines).toBe(5);
    expect(index.stats.buckets).toBe(3);
    expect(index.stats.largestBucket).toBe(3);
  });

  it("handles an empty index", () => {
    const empty = new CandidateIndex([]);
    expect(empty.candidatesFor(line("S", "2026-03-12", 5000), 0n, 5)).toEqual([]);
    expect(empty.stats).toEqual({ lines: 0, buckets: 0, largestBucket: 0 });
  });

  it("matches a zero amount against a zero amount", () => {
    const zeros = new CandidateIndex([book("Z", "2026-03-12", 0)]);
    expect(zeros.candidatesFor(line("S", "2026-03-12", 0), 0n, 1)).toEqual([0]);
  });

  it("treats a fractional window as whole days", () => {
    expect(index.candidatesFor(line("S", "2026-03-12", 5000), 0n, 2.9)).toEqual([0, 1]);
  });
});

describe("the index is exactly the scorer's gates, not an approximation", () => {
  it("admits precisely the pairs the scorer does not reject", () => {
    const dayOf = (n: number): string => date(`2026-0${1 + Math.floor(n / 28)}-${String((n % 28) + 1).padStart(2, "0")}`);
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 40 }), fc.integer({ min: -6, max: 6 })), {
          minLength: 1,
          maxLength: 25,
        }),
        fc.array(fc.tuple(fc.integer({ min: 0, max: 40 }), fc.integer({ min: -6, max: 6 })), {
          minLength: 1,
          maxLength: 25,
        }),
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 50 }),
        (bookSpec, lineSpec, windowDays, tolerance) => {
          const books = bookSpec.map(([day, units], i) => book(`B${i}`, dayOf(day), units * 100));
          const lines = lineSpec.map(([day, units], i) => line(`S${i}`, dayOf(day), units * 100));
          const index = new CandidateIndex(books);
          const options = {
            dateWindowDays: windowDays,
            amountToleranceMinorUnits: BigInt(tolerance),
          };

          lines.forEach((candidate) => {
            const admitted = new Set(
              index.candidatesFor(candidate, BigInt(tolerance), windowDays),
            );
            books.forEach((entry, bookIndex) => {
              const scored = scorePair(entry, candidate, options);
              const survives = scored.rejectedBy === null;
              expect(admitted.has(bookIndex)).toBe(survives);
            });
          });
        },
      ),
      { numRuns: 200 },
    );
  });

  it("agrees with the scorer on a generated month", () => {
    const generated = generateBooks({ seed: 55, months: 2, invoicesPerMonth: 8 });
    const books = bankView(generated.ledger, generated.bankAccount);
    const index = new CandidateIndex(books);

    let admitted = 0;
    let survived = 0;
    for (const candidate of generated.statement) {
      const found = new Set(index.candidatesFor(candidate, 0n, 7));
      admitted += found.size;
      books.forEach((entry, i) => {
        if (scorePair(entry, candidate, {}).rejectedBy === null) {
          survived += 1;
          expect(found.has(i)).toBe(true);
        } else {
          expect(found.has(i)).toBe(false);
        }
      });
    }
    expect(admitted).toBe(survived);
    // The whole point: a small fraction of the full cross product.
    expect(admitted).toBeLessThan(books.length * generated.statement.length * 0.05);
  });
});

describe("candidatePairs over both sides", () => {
  const books = [book("A", "2026-03-10", 5000), book("B", "2026-03-11", 2500)];
  const statement = [line("S1", "2026-03-10", 5000), line("S2", "2026-03-11", 2500)];

  it("pairs what belongs together", () => {
    expect(candidatePairs(books, statement, { amountTolerance: 0n, dateWindowDays: 3 })).toEqual([
      { book: 0, statement: 0 },
      { book: 1, statement: 1 },
    ]);
  });

  it("skips book lines already taken", () => {
    const pairs = candidatePairs(books, statement, {
      amountTolerance: 0n,
      dateWindowDays: 3,
      skipBook: [true, false],
    });
    expect(pairs).toEqual([{ book: 1, statement: 1 }]);
  });

  it("skips statement lines already taken", () => {
    const pairs = candidatePairs(books, statement, {
      amountTolerance: 0n,
      dateWindowDays: 3,
      skipStatement: [true, false],
    });
    expect(pairs).toEqual([{ book: 1, statement: 1 }]);
  });

  it("returns nothing when either side is empty", () => {
    expect(candidatePairs([], statement, { amountTolerance: 0n, dateWindowDays: 3 })).toEqual([]);
    expect(candidatePairs(books, [], { amountTolerance: 0n, dateWindowDays: 3 })).toEqual([]);
  });
});
