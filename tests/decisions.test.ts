import { describe, expect, it } from "vitest";
import {
  DecisionDocumentError,
  decisionPayloads,
  decisionRecord,
  decisionsFor,
  decisionsFromDocument,
  parseDecisions,
  serialiseDecisions,
  toDecision,
  type DecisionRecord,
} from "../src/reconcile/decisions.js";
import { MatchMemory } from "../src/reconcile/memory.js";

const payload = (statement: string, book: string) => ({
  statement,
  book,
  context: {},
});

describe("decisionPayloads", () => {
  it("a 1:1 pair is one fact", () => {
    const payloads = decisionPayloads({
      statementDescriptions: ["FPO ASHGROVE SUPPLIES 7606"],
      bookDescriptions: ["Payment — Ashgrove Supplies"],
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.statement).toBe("FPO ASHGROVE SUPPLIES 7606");
    expect(payloads[0]?.book).toBe("Payment — Ashgrove Supplies");
  });

  it("a batch against three suppliers is three facts", () => {
    const payloads = decisionPayloads({
      statementDescriptions: ["BACS SUPPLIER RUN 724262"],
      bookDescriptions: [
        "Payment — Ashgrove Supplies",
        "Payment — Kettleby Print",
        "Payment — Halden Utilities",
      ],
    });

    expect(payloads.map((p) => p.book)).toEqual([
      "Payment — Ashgrove Supplies",
      "Payment — Kettleby Print",
      "Payment — Halden Utilities",
    ]);
    expect(new Set(payloads.map((p) => p.statement)).size).toBe(1);
  });

  it("an aggregation of two statement lines against one entry is two facts", () => {
    const payloads = decisionPayloads({
      statementDescriptions: ["FPI FENWICK SYSTEMS 6599", "FPI FENWICK SYSTEMS 6601"],
      bookDescriptions: ["Invoice INV-2013 settled"],
    });

    expect(payloads).toHaveLength(2);
  });

  it("collapses a description repeated on one side", () => {
    const payloads = decisionPayloads({
      statementDescriptions: ["BACS PAYROLL"],
      bookDescriptions: ["Payroll — Net pay", "Payroll — Net pay", "Payroll — Net pay"],
    });

    expect(payloads).toHaveLength(1);
  });

  it("collapses on both sides at once", () => {
    const payloads = decisionPayloads({
      statementDescriptions: ["DD PROPERTY RENT", "DD PROPERTY RENT"],
      bookDescriptions: ["Monthly rent", "Monthly rent"],
    });

    expect(payloads).toHaveLength(1);
  });

  it("a four-by-four group is bounded at sixteen", () => {
    const payloads = decisionPayloads({
      statementDescriptions: ["a", "b", "c", "d"],
      bookDescriptions: ["w", "x", "y", "z"],
    });

    expect(payloads).toHaveLength(16);
  });

  it("carries the context onto every payload it produces", () => {
    const payloads = decisionPayloads({
      statementDescriptions: ["BACS SUPPLIER RUN 724262"],
      bookDescriptions: ["Payment — A", "Payment — B"],
      context: { amount: "-2053.00", kind: "group", confidence: "medium" },
    });

    expect(payloads.every((p) => p.context.amount === "-2053.00")).toBe(true);
    expect(payloads.every((p) => p.context.kind === "group")).toBe(true);
  });

  it("produces nothing when either side is empty", () => {
    expect(decisionPayloads({ statementDescriptions: [], bookDescriptions: ["x"] })).toHaveLength(0);
    expect(decisionPayloads({ statementDescriptions: ["x"], bookDescriptions: [] })).toHaveLength(0);
  });
});

describe("decisionRecord", () => {
  it("stamps the verdict and the date onto a payload", () => {
    const record = decisionRecord(payload("BANK NAME", "Ledger name"), true, "2026-04-30");

    expect(record).toMatchObject({
      statement: "BANK NAME",
      book: "Ledger name",
      accepted: true,
      on: "2026-04-30",
    });
  });

  it("refuses a date that is not a date", () => {
    expect(() => decisionRecord(payload("a", "b"), true, "not-a-date")).toThrow();
  });

  it("refuses the thirty-first of February", () => {
    expect(() => decisionRecord(payload("a", "b"), false, "2026-02-31")).toThrow();
  });
});

describe("parseDecisions", () => {
  const good: DecisionRecord[] = [
    { statement: "FPO ASHGROVE SUPPLIES 7606", book: "Payment — Ashgrove", accepted: true, on: "2026-04-30" },
    { statement: "BACS PAYROLL", book: "Payroll — Net pay", accepted: false, on: "2026-04-30" },
  ];

  it("round-trips what it writes", () => {
    expect(parseDecisions(serialiseDecisions(good))).toEqual(good);
  });

  it("keeps the order of the file", () => {
    const parsed = parseDecisions(serialiseDecisions(good));
    expect(parsed.map((r) => r.statement)).toEqual(good.map((r) => r.statement));
  });

  it("reads an empty file as no decisions", () => {
    expect(parseDecisions("[]")).toEqual([]);
  });

  it("keeps a context through the round trip", () => {
    const withContext: DecisionRecord[] = [
      {
        statement: "DD PROPERTY RENT",
        book: "Monthly rent",
        accepted: true,
        on: "2026-03-05",
        context: { amount: "-1850.00", date: "2026-03-05", kind: "pair", confidence: "high" },
      },
    ];
    expect(parseDecisions(serialiseDecisions(withContext))).toEqual(withContext);
  });

  it("drops an empty context rather than keeping a hollow object", () => {
    const parsed = parseDecisions(
      JSON.stringify([{ statement: "a", book: "b", accepted: true, on: "2026-01-01", context: {} }]),
    );
    expect(parsed[0]).not.toHaveProperty("context");
  });

  it("ignores context fields it does not know", () => {
    const parsed = parseDecisions(
      JSON.stringify([
        { statement: "a", book: "b", accepted: true, on: "2026-01-01", context: { nonsense: "x" } },
      ]),
    );
    expect(parsed[0]).not.toHaveProperty("context");
  });

  it("insists on a padded ISO date rather than guessing at 2026-1-2", () => {
    expect(() =>
      parseDecisions(JSON.stringify([{ statement: "a", book: "b", accepted: true, on: "2026-1-2" }])),
    ).toThrow(/unreadable date/);
  });

  const rejects: readonly [string, string, string][] = [
    ["not JSON at all", "{oh dear", "not valid JSON"],
    ["a JSON object", '{"statement":"a"}', "must be a JSON array"],
    ["a bare string", '"hello"', "must be a JSON array"],
    ["a null in the array", "[null]", "Decision 0 must be an object"],
    ["an array in the array", "[[]]", "Decision 0 must be an object"],
    ["a missing book side", '[{"statement":"a","accepted":true,"on":"2026-01-01"}]', "needs a statement and a book"],
    ["a numeric statement", '[{"statement":1,"book":"b","accepted":true,"on":"2026-01-01"}]', "needs a statement and a book"],
    ["a missing verdict", '[{"statement":"a","book":"b","on":"2026-01-01"}]', "accepted: true or false"],
    ["a string verdict", '[{"statement":"a","book":"b","accepted":"yes","on":"2026-01-01"}]', "accepted: true or false"],
    ["a missing date", '[{"statement":"a","book":"b","accepted":true}]', "needs the date"],
    ["an unreadable date", '[{"statement":"a","book":"b","accepted":true,"on":"yesterday"}]', "unreadable date"],
    ["a context that is a string", '[{"statement":"a","book":"b","accepted":true,"on":"2026-01-01","context":"x"}]', "context that is not an object"],
    ["a numeric context field", '[{"statement":"a","book":"b","accepted":true,"on":"2026-01-01","context":{"amount":1}}]', "context.amount"],
  ];

  it.each(rejects)("rejects %s", (_label, text, message) => {
    expect(() => parseDecisions(text)).toThrow(DecisionDocumentError);
    expect(() => parseDecisions(text)).toThrow(new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("names the index of the offending decision", () => {
    const text = JSON.stringify([
      { statement: "a", book: "b", accepted: true, on: "2026-01-01" },
      { statement: "c", book: "d", accepted: true, on: "2026-01-01" },
      { statement: "e", book: "f", accepted: true },
    ]);
    expect(() => parseDecisions(text)).toThrow(/Decision 2/);
  });

  it("validates an already-parsed document the same way", () => {
    expect(() => decisionsFromDocument({ nope: true })).toThrow(DecisionDocumentError);
    expect(decisionsFromDocument([])).toEqual([]);
  });
});

describe("what the memory does with a decisions file", () => {
  it("learns the pairings a file records", () => {
    const text = serialiseDecisions([
      { statement: "FPO ASHGROVE SUPPLIES 7606", book: "Payment — Ashgrove Supplies", accepted: true, on: "2026-03-31" },
      { statement: "SO ASHGROVE SUPPLIES 8822", book: "Payment — Ashgrove Supplies", accepted: true, on: "2026-04-30" },
    ]);

    const memory = MatchMemory.from(decisionsFor(text));

    expect(memory.size).toBe(1);
    expect(memory.recall("FPO ASHGROVE SUPPLIES 4471", "Payment — Ashgrove Supplies").kind).toBe(
      "confirmed",
    );
  });

  it("a rejection in the file is a rejection in the memory", () => {
    const text = serialiseDecisions([
      { statement: "BACS PAYROLL", book: "Monthly rent", accepted: false, on: "2026-04-30" },
    ]);

    expect(MatchMemory.from(decisionsFor(text)).recall("BACS PAYROLL", "Monthly rent").kind).toBe(
      "rejected",
    );
  });

  it("ignores the context when learning", () => {
    const bare = decisionsFor(
      serialiseDecisions([{ statement: "A LTD", book: "Payment — A", accepted: true, on: "2026-01-01" }]),
    );
    const decorated = decisionsFor(
      serialiseDecisions([
        {
          statement: "A LTD",
          book: "Payment — A",
          accepted: true,
          on: "2026-01-01",
          context: { amount: "-1.00", kind: "pair" },
        },
      ]),
    );

    expect(MatchMemory.from(bare).toDocument()).toEqual(MatchMemory.from(decorated).toDocument());
  });

  it("a payload decided both ways lands as a rejection, which outranks", () => {
    const yes = decisionRecord(payload("A LTD", "Payment — A"), true, "2026-01-01");
    const no = decisionRecord(payload("A LTD", "Payment — A"), false, "2026-02-01");
    const memory = MatchMemory.from([yes, no].map(toDecision));

    expect(memory.recall("A LTD", "Payment — A").kind).toBe("rejected");
  });
});
