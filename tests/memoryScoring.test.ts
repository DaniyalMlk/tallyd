import { describe, expect, it } from "vitest";
import { scorePair, DEFAULT_WEIGHTS } from "../src/reconcile/scoring.js";
import { reconcile } from "../src/reconcile/matcher.js";
import { MatchMemory, type Decision } from "../src/reconcile/memory.js";
import { Money } from "../src/money/money.js";
import { GBP } from "../src/money/currency.js";
import { date } from "../src/ledger/date.js";
import { statementLine, type StatementLine } from "../src/statement/line.js";
import type { BookLine } from "../src/reconcile/bankView.js";

const book = (id: string, day: string, minor: number, description: string): BookLine =>
  ({
    id,
    entryId: id,
    postingIndex: 0,
    date: date(day),
    account: "1110",
    amount: Money.ofMinor(BigInt(minor), GBP),
    description,
    normalisedDescription: description.toUpperCase(),
    reference: null,
    contraAccounts: [],
    reverses: null,
    reversedBy: null,
    tags: [],
  }) as BookLine;

const line = (id: string, day: string, minor: number, description: string): StatementLine =>
  statementLine({
    id,
    date: date(day),
    description,
    amount: Money.ofMinor(BigInt(minor), GBP),
    sourceRow: 0,
  });

const decision = (statementDescription: string, bookDescription: string, accepted = true): Decision => ({
  statementDescription,
  bookDescription,
  accepted,
  on: date("2026-03-31"),
});

// April's payment to a supplier first confirmed in March. Same penny, same day,
// but the bank's wording shares almost nothing with the ledger's.
const aprilBook = book("B1", "2026-04-14", -84200, "Payment — Ashgrove Supplies");
const aprilLine = line("S1", "2026-04-14", -84200, "SO ASHGROVE");

const marchMemory = MatchMemory.empty().learn(
  decision("FPO ASHGROVE 4471", "Payment — Ashgrove Supplies"),
);

describe("the memory rule only fires when there is something to say", () => {
  it("does not change a score when no memory is supplied at all", () => {
    const without = scorePair(aprilBook, aprilLine, {});
    const withEmpty = scorePair(aprilBook, aprilLine, { memory: MatchMemory.empty() });
    expect(withEmpty.score).toBe(without.score);
  });

  it("does not change a score for a counterparty nobody has ruled on", () => {
    const stranger = book("B2", "2026-04-14", -84200, "Payment — Somebody New");
    const strangerLine = line("S2", "2026-04-14", -84200, "SO SOMEBODY NEW 1");
    expect(scorePair(stranger, strangerLine, { memory: marchMemory }).score).toBe(
      scorePair(stranger, strangerLine, {}).score,
    );
  });

  it("carries a zero-weight reason so the reviewer sees it was considered", () => {
    const scored = scorePair(aprilBook, aprilLine, {});
    const reason = scored.reasons.find((r) => r.rule === "memory");
    expect(reason).toBeDefined();
    expect(reason?.weight).toBe(0);
    expect(reason?.detail).toContain("nothing remembered");
  });
});

describe("a confirmed counterparty raises the score", () => {
  it("scores higher than the same pair without memory", () => {
    const without = scorePair(aprilBook, aprilLine, {});
    const remembered = scorePair(aprilBook, aprilLine, { memory: marchMemory });
    expect(remembered.score).toBeGreaterThan(without.score);
  });

  it("explains itself by name and by count", () => {
    const reason = scorePair(aprilBook, aprilLine, { memory: marchMemory }).reasons.find(
      (r) => r.rule === "memory",
    );
    expect(reason?.score).toBe(1);
    expect(reason?.weight).toBe(DEFAULT_WEIGHTS.memory);
    expect(reason?.detail).toContain("confirmed once before");
    expect(reason?.detail).toContain("2026-03-31");
  });

  it("cannot carry a pair on its own past a gate", () => {
    // Same counterparty, but forty pounds out. A remembered name does not make
    // a different transaction acceptable.
    const wrongAmount = line("S3", "2026-04-14", -80200, "SO ASHGROVE 8822");
    const scored = scorePair(aprilBook, wrongAmount, { memory: marchMemory });
    expect(scored.rejectedBy).toBe("amount");
    expect(scored.score).toBe(0);
  });

  it("cannot reconcile money out against money in", () => {
    // With the default zero tolerance the amount gate closes first — +842.00
    // against -842.00 is 1684.00 apart — and the direction gate never gets a
    // look in. Either way the pair is dead, and the memory does not revive it.
    const wrongWay = line("S4", "2026-04-14", 84200, "SO ASHGROVE");
    const scored = scorePair(aprilBook, wrongWay, { memory: marchMemory });
    expect(scored.rejectedBy).toBe("amount");
    expect(scored.score).toBe(0);
  });

  it("cannot pull a pair outside the date window back in", () => {
    const tooLate = line("S5", "2026-05-20", -84200, "SO ASHGROVE");
    expect(scorePair(aprilBook, tooLate, { memory: marchMemory }).rejectedBy).toBe("date");
  });
});

describe("a refused counterparty lowers the score", () => {
  const refused = MatchMemory.empty().learn(
    decision("FPO ASHGROVE 4471", "Payment — Ashgrove Supplies", false),
  );

  it("scores lower than the same pair without memory", () => {
    expect(scorePair(aprilBook, aprilLine, { memory: refused }).score).toBeLessThan(
      scorePair(aprilBook, aprilLine, {}).score,
    );
  });

  it("overrides the exact-match floor", () => {
    // Same penny, same day, wording that agrees: this would otherwise be
    // "exact" and floored at 0.95 whatever else was known. The reviewer has
    // said no to precisely this pairing — two identical monthly payments where
    // the bank line belongs to the other one is exactly how that happens.
    const agreeing = line("S6", "2026-04-14", -84200, "PAYMENT ASHGROVE SUPPLIES");
    const withoutMemory = scorePair(aprilBook, agreeing, {});
    expect(withoutMemory.confidence).toBe("exact");
    expect(withoutMemory.score).toBeGreaterThanOrEqual(0.95);

    const samePairRefused = MatchMemory.empty().learn(
      decision("PAYMENT ASHGROVE SUPPLIES", "Payment — Ashgrove Supplies", false),
    );
    const vetoed = scorePair(aprilBook, agreeing, { memory: samePairRefused });
    expect(vetoed.confidence).not.toBe("exact");
    expect(vetoed.score).toBeLessThan(0.95);
  });

  it("says why", () => {
    const reason = scorePair(aprilBook, aprilLine, { memory: refused }).reasons.find(
      (r) => r.rule === "memory",
    );
    expect(reason?.detail).toContain("rejected once before");
  });

  it("treats a name only ever confirmed elsewhere as evidence against", () => {
    const elsewhere = book("B7", "2026-04-14", -84200, "Payment — Kettleby Print");
    const scored = scorePair(elsewhere, aprilLine, { memory: marchMemory });
    const reason = scored.reasons.find((r) => r.rule === "memory");
    expect(reason?.score).toBe(0);
    expect(reason?.weight).toBe(DEFAULT_WEIGHTS.memory);
    expect(scored.score).toBeLessThan(scorePair(elsewhere, aprilLine, {}).score);
  });
});

describe("the matcher acts on what is remembered", () => {
  it("promotes a repeat counterparty out of the review queue", () => {
    const books = [aprilBook];
    const statement = [aprilLine];

    const cold = reconcile(books, statement);
    expect(cold.suggested).toHaveLength(1);
    expect(cold.matched).toHaveLength(0);
    // Borderline on the wording alone, which is the band memory is for.
    expect(cold.suggested[0]?.scored.score).toBeGreaterThan(0.8);
    expect(cold.suggested[0]?.scored.score).toBeLessThan(0.86);

    const warm = reconcile(books, statement, { memory: marchMemory });
    expect(warm.matched).toHaveLength(1);
    expect(warm.suggested).toHaveLength(0);
    expect(warm.matched[0]?.book[0]?.id).toBe("B1");
  });

  it("does not promote a pair the numbers do not already support", () => {
    // A day apart and sharing much less wording. A remembered counterparty
    // lifts this but nowhere near far enough, which is the point: memory
    // cannot carry a weak pair on its own.
    const weakBook = book("B9", "2026-04-14", -84200, "Payment — Ashgrove Supplies");
    const weakLine = line("S9", "2026-04-15", -84200, "DD ASHGROVE");

    const warm = reconcile([weakBook], [weakLine], {
      memory: MatchMemory.empty().learn(decision("DD ASHGROVE", "Payment — Ashgrove Supplies")),
    });
    expect(warm.matched).toHaveLength(0);
    expect(warm.suggested).toHaveLength(1);
  });

  it("breaks a tie towards the counterparty that has been seen before", () => {
    // Two suppliers, same amount, same day. Nothing in the numbers separates
    // them; only the memory does.
    const books = [
      book("B1", "2026-04-14", -84200, "Payment — Ashgrove Supplies"),
      book("B2", "2026-04-14", -84200, "Payment — Kettleby Print"),
    ];
    const statement = [
      line("S1", "2026-04-14", -84200, "SO ASHGROVE"),
      line("S2", "2026-04-14", -84200, "SO ANOTHER NAME"),
    ];

    const warm = reconcile(books, statement, { memory: marchMemory });
    const pairing = [...warm.matched, ...warm.suggested].find((match) =>
      match.statement.some((entry) => entry.id === "S1"),
    );
    expect(pairing?.book[0]?.id).toBe("B1");
  });

  it("leaves a run with no memory exactly as it was", () => {
    const books = [
      book("B1", "2026-04-14", -84200, "Payment — Ashgrove Supplies"),
      book("B2", "2026-04-16", -1850_00, "Monthly rent"),
    ];
    const statement = [
      line("S1", "2026-04-14", -84200, "SO ASHGROVE"),
      line("S2", "2026-04-16", -1850_00, "DD PROPERTY RENT"),
    ];

    const plain = reconcile(books, statement);
    const empty = reconcile(books, statement, { memory: MatchMemory.empty() });

    expect(empty.matched.map((m) => m.scored.score)).toEqual(
      plain.matched.map((m) => m.scored.score),
    );
    expect(empty.suggested.map((m) => m.scored.score)).toEqual(
      plain.suggested.map((m) => m.scored.score),
    );
  });
});
