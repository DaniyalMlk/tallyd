import { describe, expect, it } from "vitest";
import { GBP, USD, Money } from "../src/money/index.js";
import { date } from "../src/ledger/index.js";
import { statementLine, normaliseDescription } from "../src/statement/index.js";
import type { StatementLine } from "../src/statement/index.js";
import type { BookLine } from "../src/reconcile/bankView.js";
import {
  DEFAULT_WEIGHTS,
  resolveScoringOptions,
  scorePair,
  scoreGroup,
} from "../src/reconcile/scoring.js";

const gbp = (text: string) => Money.parse(text, GBP);

function book(overrides: {
  id?: string;
  entryId?: string;
  amount: Money;
  date: string;
  description: string;
  reference?: string;
}): BookLine {
  return Object.freeze({
    id: overrides.id ?? "JE-1#0",
    entryId: overrides.entryId ?? "JE-1",
    postingIndex: 0,
    date: date(overrides.date),
    account: "1110",
    amount: overrides.amount,
    description: overrides.description,
    normalisedDescription: normaliseDescription(overrides.description),
    reference: overrides.reference ?? null,
    contraAccounts: Object.freeze(["5300"]),
    reverses: null,
    reversedBy: null,
    tags: Object.freeze([]),
  }) as BookLine;
}

function line(
  overrides: { id?: string; date: string; description: string; amount: Money; reference?: string },
): StatementLine {
  return statementLine({
    id: overrides.id ?? "BANK-1",
    date: date(overrides.date),
    description: overrides.description,
    amount: overrides.amount,
    sourceRow: 0,
    ...(overrides.reference !== undefined ? { reference: overrides.reference } : {}),
  });
}

describe("resolveScoringOptions", () => {
  it("fills in defaults and merges partial weights", () => {
    const resolved = resolveScoringOptions();
    expect(resolved.dateWindowDays).toBe(7);
    expect(resolved.amountToleranceMinorUnits).toBe(0n);
    expect(resolved.weights).toEqual(DEFAULT_WEIGHTS);

    const custom = resolveScoringOptions({ weights: { description: 0.9 }, dateWindowDays: 3 });
    expect(custom.weights.description).toBe(0.9);
    expect(custom.weights.amount).toBe(DEFAULT_WEIGHTS.amount);
    expect(custom.dateWindowDays).toBe(3);
  });
});

describe("scorePair gates", () => {
  const rentBook = book({ date: "2026-08-04", description: "August rent", amount: gbp("-1850.00") });

  it("rejects on an amount difference outside tolerance and says by how much", () => {
    const scored = scorePair(
      rentBook,
      line({ date: "2026-08-04", description: "DD RENT, AUGUST 08", amount: gbp("-1855.00") }),
    );
    expect(scored.rejectedBy).toBe("amount");
    expect(scored.confidence).toBe("rejected");
    expect(scored.score).toBe(0);
    expect(scored.amountGap).toBe(-500n);
    expect(scored.reasons.at(-1)?.detail).toContain("-5.00");
  });

  it("accepts a small difference when a tolerance is allowed", () => {
    const scored = scorePair(
      rentBook,
      line({ date: "2026-08-04", description: "DD RENT, AUGUST 08", amount: gbp("-1850.02") }),
      { amountToleranceMinorUnits: 5n },
    );
    expect(scored.rejectedBy).toBeNull();
    expect(scored.amountGap).toBe(-2n);
    expect(scored.reasons[0]?.detail).toContain("within tolerance");
  });

  it("rejects money in against money out", () => {
    const scored = scorePair(
      rentBook,
      line({ date: "2026-08-04", description: "August rent", amount: gbp("1850.00") }),
    );
    expect(scored.rejectedBy).toBe("amount");
  });

  it("rejects a genuine direction clash where the magnitudes agree", () => {
    const refund = book({
      date: "2026-08-04",
      description: "Refund received",
      amount: gbp("1850.00"),
    });
    const scored = scorePair(
      refund,
      line({ date: "2026-08-04", description: "Refund received", amount: gbp("-1850.00") }),
    );
    expect(scored.rejectedBy).toBe("amount");
  });

  it("rejects a pair outside the date window", () => {
    const scored = scorePair(
      rentBook,
      line({ date: "2026-08-20", description: "DD RENT, AUGUST 08", amount: gbp("-1850.00") }),
    );
    expect(scored.rejectedBy).toBe("date");
    expect(scored.dayGap).toBe(16);
    expect(scored.reasons.at(-1)?.detail).toContain("outside the 7 day window");
  });

  it("rejects a currency mismatch before anything else", () => {
    const scored = scorePair(
      rentBook,
      line({ date: "2026-08-04", description: "August rent", amount: Money.parse("-1850.00", USD) }),
    );
    expect(scored.rejectedBy).toBe("amount");
    expect(scored.reasons.at(-1)?.detail).toContain("USD");
  });
});

describe("scorePair scoring", () => {
  it("scores an identical description, day and amount at the top", () => {
    const scored = scorePair(
      book({ date: "2026-08-31", description: "Bank charges", amount: gbp("-18.00") }),
      line({ date: "2026-08-31", description: "BANK CHARGES", amount: gbp("-18.00") }),
    );
    expect(scored.confidence).toBe("exact");
    expect(scored.score).toBeCloseTo(1, 6);
    expect(scored.dayGap).toBe(0);
    expect(scored.amountGap).toBe(0n);
  });

  it("sees through card-descriptor noise, because it compares normalised text", () => {
    const scored = scorePair(
      book({ date: "2026-08-04", description: "August rent", amount: gbp("-1850.00") }),
      line({ date: "2026-08-04", description: "DD RENT, AUGUST 08", amount: gbp("-1850.00") }),
    );
    expect(scored.score).toBeGreaterThan(0.86);
    expect(scored.confidence).toBe("high");
  });

  it("lets a shared reference carry a match the wording would have sunk", () => {
    const scored = scorePair(
      book({
        date: "2026-08-12",
        description: "Invoice 1001 settled",
        amount: gbp("7200.00"),
      }),
      line({ date: "2026-08-12", description: "FPI ACME LTD INV1001", amount: gbp("7200.00") }),
    );
    expect(scored.reasons.find((r) => r.rule === "reference")?.detail).toContain("1001");
    expect(scored.confidence).toBe("exact");
    expect(scored.score).toBeGreaterThanOrEqual(0.95);
  });

  it("drops the reference rule when neither side has one", () => {
    const scored = scorePair(
      book({ date: "2026-08-31", description: "Bank charges", amount: gbp("-18.00") }),
      line({ date: "2026-08-31", description: "BANK CHARGES", amount: gbp("-18.00") }),
    );
    const reference = scored.reasons.find((r) => r.rule === "reference");
    expect(reference?.weight).toBe(0);
    expect(reference?.detail).toBe("neither side carries a reference");
  });

  it("penalises disagreeing references", () => {
    const agreeing = scorePair(
      book({ date: "2026-08-12", description: "Invoice 1001", amount: gbp("7200.00") }),
      line({ date: "2026-08-12", description: "ACME INV1001", amount: gbp("7200.00") }),
    );
    const disagreeing = scorePair(
      book({ date: "2026-08-12", description: "Invoice 1001", amount: gbp("7200.00") }),
      line({ date: "2026-08-12", description: "ACME INV2002", amount: gbp("7200.00") }),
    );
    expect(disagreeing.score).toBeLessThan(agreeing.score);
    expect(disagreeing.reasons.find((r) => r.rule === "reference")?.detail).toBe(
      "references disagree",
    );
  });

  it("decays with the date gap, and faster than linearly", () => {
    const at = (days: number) =>
      scorePair(
        book({ date: "2026-08-10", description: "Widget purchase", amount: gbp("-90.00") }),
        line({
          date: `2026-08-${String(10 + days).padStart(2, "0")}`,
          description: "WIDGET PURCHASE",
          amount: gbp("-90.00"),
        }),
      ).score;

    expect(at(0)).toBeGreaterThan(at(1));
    expect(at(1)).toBeGreaterThan(at(3));
    expect(at(3)).toBeGreaterThan(at(6));
    expect(at(0) - at(1)).toBeLessThan(at(3) - at(6));
  });

  it("names the direction of the date gap in plain words", () => {
    const later = scorePair(
      book({ date: "2026-08-05", description: "Card sale", amount: gbp("473.08") }),
      line({ date: "2026-08-07", description: "SETTLEMENT", amount: gbp("473.08") }),
    );
    expect(later.reasons.find((r) => r.rule === "date")?.detail).toBe("2 days later on the statement");

    const earlier = scorePair(
      book({ date: "2026-08-07", description: "Card sale", amount: gbp("473.08") }),
      line({ date: "2026-08-06", description: "SETTLEMENT", amount: gbp("473.08") }),
    );
    expect(earlier.reasons.find((r) => r.rule === "date")?.detail).toBe(
      "1 day earlier on the statement",
    );
  });

  it("keeps every score inside 0..1 and the contributions consistent", () => {
    const descriptions = ["August rent", "Bank charges", "Invoice 1001 settled", "Payroll"];
    for (const bookText of descriptions) {
      for (const lineText of descriptions) {
        const scored = scorePair(
          book({ date: "2026-08-10", description: bookText, amount: gbp("-100.00") }),
          line({ date: "2026-08-12", description: lineText, amount: gbp("-100.00") }),
        );
        expect(scored.score).toBeGreaterThanOrEqual(0);
        expect(scored.score).toBeLessThanOrEqual(1);
        for (const reason of scored.reasons) {
          expect(reason.contribution).toBeCloseTo(reason.score * reason.weight, 12);
        }
      }
    }
  });
});

describe("scoreGroup", () => {
  const suppliers = [
    book({ id: "A#1", date: "2026-09-10", description: "Kestrel Print", amount: gbp("-412.80") }),
    book({ id: "B#1", date: "2026-09-10", description: "Halden Office", amount: gbp("-168.44") }),
    book({ id: "C#1", date: "2026-09-10", description: "Mirrell Legal", amount: gbp("-1250.00") }),
    book({ id: "D#1", date: "2026-09-10", description: "Corbin Facilities", amount: gbp("-306.76") }),
  ];
  const bacs = line({
    date: "2026-09-10",
    description: "BACS SUPPLIER RUN 100926",
    amount: gbp("-2138.00"),
  });

  it("scores a batch against its total", () => {
    const scored = scoreGroup(suppliers, [bacs]);
    expect(scored.rejectedBy).toBeNull();
    expect(scored.amountGap).toBe(0n);
    expect(scored.score).toBeGreaterThan(0.45);
  });

  it("rejects a batch that does not add up", () => {
    const scored = scoreGroup(suppliers.slice(0, 3), [bacs]);
    expect(scored.rejectedBy).toBe("amount");
  });

  it("discounts wider groups, because there are more ways to be accidentally right", () => {
    const pairScore = scoreGroup([suppliers[0] as BookLine], [
      line({ date: "2026-09-10", description: "KESTREL PRINT", amount: gbp("-412.80") }),
    ]).score;
    const groupScore = scoreGroup(
      [suppliers[0] as BookLine, suppliers[1] as BookLine],
      [line({ date: "2026-09-10", description: "KESTREL PRINT", amount: gbp("-581.24") })],
    ).score;
    expect(groupScore).toBeLessThan(pairScore);
  });

  it("never reports a group as exact", () => {
    const scored = scoreGroup(
      [
        book({ id: "A#1", date: "2026-09-20", description: "Northwind INV1042", amount: gbp("2400.00") }),
        book({ id: "B#1", date: "2026-09-20", description: "Northwind INV1043", amount: gbp("1800.00") }),
      ],
      [line({ date: "2026-09-20", description: "FPI NORTHWIND LTD INV1042", amount: gbp("4200.00") })],
    );
    expect(scored.confidence).not.toBe("exact");
    expect(scored.score).toBeGreaterThan(0.7);
  });

  it("rejects an empty side", () => {
    expect(scoreGroup([], [bacs]).confidence).toBe("rejected");
    expect(scoreGroup(suppliers, []).confidence).toBe("rejected");
  });

  it("uses the earliest date on each side, so a spread batch is not punished twice", () => {
    const spread = [
      book({ id: "A#1", date: "2026-09-10", description: "Kestrel Print", amount: gbp("-412.80") }),
      book({ id: "B#1", date: "2026-09-12", description: "Halden Office", amount: gbp("-168.44") }),
    ];
    const scored = scoreGroup(spread, [
      line({ date: "2026-09-10", description: "BACS RUN", amount: gbp("-581.24") }),
    ]);
    expect(scored.dayGap).toBe(0);
  });
});
