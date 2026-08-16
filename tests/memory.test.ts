import { describe, expect, it } from "vitest";
import {
  MatchMemory,
  MemoryDocumentError,
  counterpartyKey,
  renderMemory,
  type Decision,
} from "../src/reconcile/memory.js";
import { date } from "../src/ledger/date.js";

const on = date("2026-03-31");

const decision = (
  statementDescription: string,
  bookDescription: string,
  accepted = true,
  when = on,
): Decision => ({ statementDescription, bookDescription, accepted, on: when });

describe("counterpartyKey keeps the part that does not change", () => {
  it("drops the reference numbers and the terminal id", () => {
    // "BILL" survives because it carries no digit once the hyphen is split.
    // That is fine and deliberate: the key does not have to be minimal, it has
    // to be the same in March as it is in April. Trying to strip words like
    // "BILL" or "INV" would be fitting the key to one bank's phrasing.
    expect(counterpartyKey("FPO ASHGROVE SUPPLIES 4471 BILL-3104")).toBe("ASHGROVE BILL SUPPLIES");
    expect(counterpartyKey("FPO ASHGROVE SUPPLIES 4471 BILL-3104")).not.toContain("4471");
    expect(counterpartyKey("FPO ASHGROVE SUPPLIES 4471 BILL-3104")).not.toContain("3104");
    expect(counterpartyKey("FPO ASHGROVE SUPPLIES 4471 BILL-3104")).not.toContain("FPO");
  });

  it("gives the same key in a later month with different numbers", () => {
    expect(counterpartyKey("SO ASHGROVE SUPPLIES 8822 BILL-3391")).toBe(
      counterpartyKey("FPO ASHGROVE SUPPLIES 4471 BILL-3104"),
    );
  });

  it("does not care about word order", () => {
    expect(counterpartyKey("Payment — Ashgrove Supplies")).toBe(
      counterpartyKey("Ashgrove Supplies payment"),
    );
  });

  it("does not care about case or punctuation", () => {
    expect(counterpartyKey("Calder & Voss")).toBe(counterpartyKey("CALDER VOSS"));
  });

  it("drops tokens too short to identify anybody", () => {
    expect(counterpartyKey("TO ACME RE INVOICE")).toBe("ACME INVOICE");
  });

  it("collapses a repeated word", () => {
    expect(counterpartyKey("ACME ACME LTD")).toBe("ACME LTD");
  });

  it("gives an empty key to a description with nothing stable in it", () => {
    expect(counterpartyKey("4471 8822")).toBe("");
    expect(counterpartyKey("")).toBe("");
  });

  it("separates two different counterparties", () => {
    expect(counterpartyKey("FPO ACME LTD 1234")).not.toBe(counterpartyKey("FPO NORTHWIND LTD 1234"));
  });
});

describe("a memory with nothing in it", () => {
  it("remembers nothing", () => {
    const memory = MatchMemory.empty();
    expect(memory.size).toBe(0);
    expect(memory.entries).toEqual([]);
    expect(memory.recall("FPO ACME 1", "Payment — Acme").kind).toBe("unknown");
  });

  it("renders as a sentence rather than an empty table", () => {
    expect(renderMemory(MatchMemory.empty())).toBe("Nothing remembered yet.");
  });
});

describe("learning from confirmations", () => {
  it("recognises the same counterparty next month", () => {
    const memory = MatchMemory.empty().learn(
      decision("FPO ASHGROVE SUPPLIES 4471 BILL-3104", "Payment — Ashgrove Supplies"),
    );
    const verdict = memory.recall("SO ASHGROVE SUPPLIES 8822 BILL-3391", "Payment — Ashgrove Supplies");

    expect(verdict.kind).toBe("confirmed");
    expect(verdict.score).toBe(1);
    expect(verdict.confirmed).toBe(1);
    expect(verdict.detail).toContain("confirmed once before");
  });

  it("counts repeats rather than duplicating the entry", () => {
    const memory = MatchMemory.from([
      decision("FPO ACME 1", "Payment — Acme"),
      decision("FPO ACME 2", "Payment — Acme"),
      decision("FPO ACME 3", "Payment — Acme"),
    ]);
    expect(memory.size).toBe(1);
    expect(memory.recall("FPO ACME 9", "Payment — Acme").confirmed).toBe(3);
    expect(memory.recall("FPO ACME 9", "Payment — Acme").detail).toContain("3 times");
  });

  it("keeps the latest date it saw", () => {
    const memory = MatchMemory.from([
      decision("FPO ACME 1", "Payment — Acme", true, date("2026-01-05")),
      decision("FPO ACME 2", "Payment — Acme", true, date("2026-04-09")),
      decision("FPO ACME 3", "Payment — Acme", true, date("2026-02-02")),
    ]);
    expect(memory.entries[0]?.lastSeen).toBe("2026-04-09");
  });

  it("says nothing about a counterparty it has not seen", () => {
    const memory = MatchMemory.empty().learn(decision("FPO ACME 1", "Payment — Acme"));
    expect(memory.recall("FPO NORTHWIND 1", "Receipt — Northwind").kind).toBe("unknown");
  });

  it("is immutable: learning returns a new memory", () => {
    const before = MatchMemory.empty();
    const after = before.learn(decision("FPO ACME 1", "Payment — Acme"));
    expect(before.size).toBe(0);
    expect(after.size).toBe(1);
  });

  it("drops a decision with no stable name on either side", () => {
    const memory = MatchMemory.empty()
      .learn(decision("4471 8822", "Payment — Acme"))
      .learn(decision("FPO ACME 1", "9931"));
    expect(memory.size).toBe(0);
  });
});

describe("learning from rejections", () => {
  it("refuses a pairing a reviewer already refused", () => {
    const memory = MatchMemory.empty().learn(
      decision("FPO ACME LTD 1", "Payment — Northwind", false),
    );
    const verdict = memory.recall("FPO ACME LTD 2", "Payment — Northwind");

    expect(verdict.kind).toBe("rejected");
    expect(verdict.score).toBe(0);
    expect(verdict.detail).toContain("rejected once before");
  });

  it("lets a rejection outweigh a confirmation of the same pairing", () => {
    const memory = MatchMemory.from([
      decision("FPO ACME 1", "Payment — Acme", true),
      decision("FPO ACME 2", "Payment — Acme", true),
      decision("FPO ACME 3", "Payment — Acme", false),
    ]);
    const verdict = memory.recall("FPO ACME 4", "Payment — Acme");
    expect(verdict.kind).toBe("rejected");
    expect(verdict.detail).toContain("accepted 2 times");
  });

  it("treats a name only ever confirmed elsewhere as evidence against", () => {
    const memory = MatchMemory.empty().learn(decision("FPO ACME LTD 1", "Payment — Acme"));
    const verdict = memory.recall("FPO ACME LTD 2", "Payment — Someone Else");

    expect(verdict.kind).toBe("contradicted");
    expect(verdict.score).toBe(0);
    expect(verdict.detail).toContain("confirmed against something else");
  });

  it("stops contradicting once the second pairing is confirmed too", () => {
    // A shared bank descriptor covering two ledger accounts is unusual but real.
    const memory = MatchMemory.from([
      decision("FPO ACME LTD 1", "Payment — Acme"),
      decision("FPO ACME LTD 2", "Payment — Acme Rentals"),
    ]);
    expect(memory.recall("FPO ACME LTD 3", "Payment — Acme").kind).toBe("confirmed");
    expect(memory.recall("FPO ACME LTD 3", "Payment — Acme Rentals").kind).toBe("confirmed");
  });

  it("does not contradict on the strength of a rejection alone", () => {
    const memory = MatchMemory.empty().learn(decision("FPO ACME 1", "Payment — Acme", false));
    expect(memory.recall("FPO ACME 2", "Payment — Somebody").kind).toBe("unknown");
  });
});

describe("forgetting", () => {
  it("removes a pairing recorded in error", () => {
    const memory = MatchMemory.empty().learn(decision("FPO ACME 1", "Payment — Acme"));
    const after = memory.forget("FPO ACME 2", "Payment — Acme");
    expect(after.size).toBe(0);
    expect(after.recall("FPO ACME 3", "Payment — Acme").kind).toBe("unknown");
  });

  it("stops contradicting once the confirmation behind it is gone", () => {
    const memory = MatchMemory.empty().learn(decision("FPO ACME LTD 1", "Payment — Acme"));
    expect(memory.recall("FPO ACME LTD 2", "Payment — Other").kind).toBe("contradicted");
    expect(memory.forget("FPO ACME LTD 1", "Payment — Acme").recall("FPO ACME LTD 2", "Payment — Other").kind).toBe(
      "unknown",
    );
  });

  it("is a no-op for something never learnt", () => {
    const memory = MatchMemory.empty().learn(decision("FPO ACME 1", "Payment — Acme"));
    expect(memory.forget("FPO NOBODY 1", "Payment — Nobody").size).toBe(1);
  });
});

describe("saving and loading", () => {
  const memory = MatchMemory.from([
    decision("FPO ASHGROVE SUPPLIES 4471", "Payment — Ashgrove Supplies"),
    decision("FPO ASHGROVE SUPPLIES 8822", "Payment — Ashgrove Supplies"),
    decision("BGC NORTHWIND LTD 1", "Receipt — Northwind Ltd", false),
  ]);

  it("round-trips through JSON", () => {
    const loaded = MatchMemory.fromJson(memory.toJson());
    expect(loaded.entries).toEqual(memory.entries);
    expect(loaded.recall("FPO ASHGROVE SUPPLIES 1", "Payment — Ashgrove Supplies").confirmed).toBe(2);
    expect(loaded.recall("BGC NORTHWIND LTD 9", "Receipt — Northwind Ltd").kind).toBe("rejected");
  });

  it("rebuilds the contradiction index on load", () => {
    const loaded = MatchMemory.fromJson(memory.toJson());
    expect(loaded.recall("FPO ASHGROVE SUPPLIES 1", "Payment — Somebody Else").kind).toBe(
      "contradicted",
    );
  });

  it("writes something a person could edit by hand", () => {
    const text = memory.toJson();
    expect(text).toContain('"statementKey": "ASHGROVE SUPPLIES"');
    expect(text).toContain('"confirmed": 2');
    expect(text.endsWith("\n")).toBe(true);
  });

  it("orders entries most-confirmed first", () => {
    expect(memory.entries[0]?.confirmed).toBe(2);
  });

  it("rejects a document that is not one", () => {
    expect(() => MatchMemory.fromDocument(null)).toThrow(MemoryDocumentError);
    expect(() => MatchMemory.fromDocument(42)).toThrow(MemoryDocumentError);
    expect(() => MatchMemory.fromJson("{ not json")).toThrow(MemoryDocumentError);
  });

  it("rejects an unsupported version", () => {
    expect(() => MatchMemory.fromDocument({ version: 2, entries: [] })).toThrow(/version/);
  });

  it("rejects a missing or malformed entries array", () => {
    expect(() => MatchMemory.fromDocument({ version: 1 })).toThrow(/entries/);
    expect(() => MatchMemory.fromDocument({ version: 1, entries: {} })).toThrow(/entries/);
  });

  it("rejects an entry missing its keys", () => {
    expect(() =>
      MatchMemory.fromDocument({ version: 1, entries: [{ confirmed: 1, lastSeen: "2026-01-01" }] }),
    ).toThrow(/statementKey/);
  });

  it("rejects a negative or fractional count", () => {
    const entry = { statementKey: "A", bookKey: "B", lastSeen: "2026-01-01" };
    expect(() =>
      MatchMemory.fromDocument({ version: 1, entries: [{ ...entry, confirmed: -1 }] }),
    ).toThrow(/nonsensical/);
    expect(() =>
      MatchMemory.fromDocument({ version: 1, entries: [{ ...entry, confirmed: 1.5 }] }),
    ).toThrow(/nonsensical/);
  });

  it("rejects an entry recording nothing at all", () => {
    expect(() =>
      MatchMemory.fromDocument({
        version: 1,
        entries: [{ statementKey: "A", bookKey: "B", confirmed: 0, rejected: 0, lastSeen: "2026-01-01" }],
      }),
    ).toThrow(/neither/);
  });

  it("rejects an entry without a date", () => {
    expect(() =>
      MatchMemory.fromDocument({
        version: 1,
        entries: [{ statementKey: "A", bookKey: "B", confirmed: 1 }],
      }),
    ).toThrow(/lastSeen/);
  });

  it("loads an empty memory", () => {
    expect(MatchMemory.fromDocument({ version: 1, entries: [] }).size).toBe(0);
  });
});

describe("rendering what is remembered", () => {
  it("lists the pairings with their counts", () => {
    const memory = MatchMemory.from([
      decision("FPO ASHGROVE SUPPLIES 1", "Payment — Ashgrove Supplies"),
      decision("FPO ASHGROVE SUPPLIES 2", "Payment — Ashgrove Supplies"),
      decision("BGC NORTHWIND 1", "Receipt — Northwind", false),
    ]);
    const text = renderMemory(memory);

    expect(text).toContain("2 remembered pairings");
    expect(text).toContain("ASHGROVE SUPPLIES");
    expect(text).toContain("2/0");
    expect(text).toContain("0/1");
  });

  it("says pairing, singular, for one", () => {
    const memory = MatchMemory.empty().learn(decision("FPO ACME 1", "Payment — Acme"));
    expect(renderMemory(memory)).toContain("1 remembered pairing\n");
  });
});
