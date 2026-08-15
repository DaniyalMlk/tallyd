import { describe, expect, it } from "vitest";
import { GBP, USD, Money } from "../src/money/index.js";
import { JournalEntry, Ledger, UnbalancedEntryError } from "../src/ledger/index.js";
import { standardChart } from "../src/accounts/index.js";
import {
  LedgerDocumentError,
  entryToDocument,
  ledgerFromDocument,
  ledgerFromJson,
  ledgerToDocument,
  ledgerToJson,
} from "../src/ledger/serialise.js";
import { demoLedger } from "../src/demo/month.js";
import { receivablesLedger } from "../src/demo/receivables.js";

const gbp = (text: string) => Money.parse(text, GBP);

describe("entryToDocument", () => {
  it("keeps amounts as decimal strings, never numbers", () => {
    const entry = JournalEntry.simple({
      id: "JE-1",
      date: "2026-08-04",
      narration: "August rent",
      debit: "5300",
      credit: "1110",
      amount: gbp("1850.00"),
    });
    const document = entryToDocument(entry);
    expect(document.postings[0]?.amount).toBe("1850.00");
    expect(typeof document.postings[0]?.amount).toBe("string");
    expect(document.postings[0]?.currency).toBe("GBP");
  });

  it("omits the fields that were not set rather than writing nulls", () => {
    const bare = entryToDocument(
      JournalEntry.simple({
        id: "JE-1",
        date: "2026-08-04",
        narration: "Rent",
        debit: "5300",
        credit: "1110",
        amount: gbp("10.00"),
      }),
    );
    expect(bare.reference).toBeUndefined();
    expect(bare.tags).toBeUndefined();
    expect(bare.reverses).toBeUndefined();
    expect(bare.postings[0]?.memo).toBeUndefined();
  });

  it("carries references, tags, memos and reversal links", () => {
    const entry = JournalEntry.create({
      id: "JE-2",
      date: "2026-08-12",
      narration: "Invoice settled",
      reference: "INV-1001",
      tags: ["sales", "northwind"],
      postings: [
        { account: "1110", amount: gbp("7200.00"), memo: "cleared funds" },
        { account: "1130", amount: gbp("-7200.00") },
      ],
    });
    const document = entryToDocument(entry);
    expect(document.reference).toBe("INV-1001");
    expect(document.tags).toEqual(["sales", "northwind"]);
    expect(document.postings[0]?.memo).toBe("cleared funds");
  });
});

describe("round tripping", () => {
  for (const [name, build] of [
    ["the worked month", demoLedger],
    ["the receivables quarter", receivablesLedger],
  ] as const) {
    it(`survives ${name} intact`, () => {
      const original = build();
      const json = ledgerToJson(original);
      const restored = ledgerFromJson(json);

      expect(restored.size).toBe(original.size);
      expect(ledgerToJson(restored)).toBe(json);

      for (const entry of original.all()) {
        const back = restored.entry(entry.id);
        expect(back).toBeDefined();
        expect(back?.date).toBe(entry.date);
        expect(back?.narration).toBe(entry.narration);
        expect(back?.reference).toBe(entry.reference);
        expect(back?.tags).toEqual(entry.tags);
        expect(back?.reverses).toBe(entry.reverses);
        expect(back?.postings.map((p) => [p.account, p.amount.toDecimalString(), p.memo])).toEqual(
          entry.postings.map((p) => [p.account, p.amount.toDecimalString(), p.memo]),
        );
      }
    });
  }

  it("preserves every balance", () => {
    const original = demoLedger();
    const restored = ledgerFromJson(ledgerToJson(original));
    for (const account of original.activeAccounts()) {
      expect(restored.balanceOf(account).minorUnits).toBe(original.balanceOf(account).minorUnits);
    }
  });

  it("preserves the chart, including placeholders and hierarchy", () => {
    const restored = ledgerFromJson(ledgerToJson(demoLedger()));
    const original = standardChart(GBP);
    expect(restored.chart?.size).toBe(original.size);
    expect(restored.chart?.get("1110").parent).toBe("1100");
    expect(restored.chart?.get("1100").placeholder).toBe(true);
    expect(restored.chart?.get("1110").placeholder).toBe(false);
    expect(restored.chart?.get("5500").description).toBe(original.get("5500").description);
  });

  it("keeps a non-default account currency", () => {
    const chart = standardChart(GBP).extend([
      { code: "1160", name: "Dollar Account", type: "asset", parent: "1100", currency: USD },
    ]);
    const ledger = Ledger.empty(chart).post(
      JournalEntry.simple({
        id: "JE-1",
        date: "2026-08-01",
        narration: "Dollar receipt",
        debit: "1160",
        credit: "4100",
        amount: Money.parse("500.00", USD),
      }),
    );
    const restored = ledgerFromJson(ledgerToJson(ledger));
    expect(restored.chart?.get("1160").currency.code).toBe("USD");
    expect(restored.balanceOf("1160", "USD").toDecimalString()).toBe("500.00");
  });

  it("handles a ledger with no chart at all", () => {
    const ledger = Ledger.from([
      JournalEntry.simple({
        id: "JE-1",
        date: "2026-08-01",
        narration: "Anything",
        debit: "A",
        credit: "B",
        amount: gbp("1.00"),
      }),
    ]);
    const restored = ledgerFromJson(ledgerToJson(ledger));
    expect(restored.chart).toBeUndefined();
    expect(restored.balanceOf("A").toDecimalString()).toBe("1.00");
  });

  it("handles an empty ledger", () => {
    const document = ledgerToDocument(Ledger.empty(standardChart(GBP)));
    expect(document.entries).toEqual([]);
    expect(ledgerFromDocument(document).isEmpty).toBe(true);
  });
});

describe("rejecting bad documents", () => {
  const valid = {
    version: 1,
    currency: "GBP",
    accounts: [],
    entries: [
      {
        id: "JE-1",
        date: "2026-08-01",
        narration: "Rent",
        postings: [
          { account: "5300", amount: "10.00", currency: "GBP" },
          { account: "1110", amount: "-10.00", currency: "GBP" },
        ],
      },
    ],
  };

  it("accepts the valid baseline", () => {
    expect(ledgerFromDocument(valid).size).toBe(1);
  });

  it("refuses a numeric amount, because that is where precision goes to die", () => {
    const broken = structuredClone(valid) as Record<string, unknown>;
    (((broken["entries"] as unknown[])[0] as Record<string, unknown>)["postings"] as unknown[])[0] = {
      account: "5300",
      amount: 10.0,
      currency: "GBP",
    };
    expect(() => ledgerFromDocument(broken)).toThrow(/decimal strings/);
  });

  it("refuses an unbalanced entry rather than loading it", () => {
    const broken = structuredClone(valid) as Record<string, unknown>;
    (((broken["entries"] as unknown[])[0] as Record<string, unknown>)["postings"] as unknown[])[1] = {
      account: "1110",
      amount: "-9.00",
      currency: "GBP",
    };
    expect(() => ledgerFromDocument(broken)).toThrow(UnbalancedEntryError);
  });

  it("refuses an unknown version", () => {
    expect(() => ledgerFromDocument({ ...valid, version: 2 })).toThrow(LedgerDocumentError);
    expect(() => ledgerFromDocument({ ...valid, version: undefined })).toThrow(/version/);
  });

  it("refuses an account type that is not one of the five", () => {
    expect(() =>
      ledgerFromDocument({
        ...valid,
        accounts: [{ code: "1", name: "Odd", type: "goodwill" }],
      }),
    ).toThrow(/not an account type/);
  });

  it("refuses malformed shapes with a message naming the field", () => {
    expect(() => ledgerFromDocument(null)).toThrow(/must be an object/);
    expect(() => ledgerFromDocument({ version: 1, currency: 7 })).toThrow(/currency must be a string/);
    expect(() => ledgerFromDocument({ version: 1, currency: "GBP", entries: "no" })).toThrow(
      /entries must be an array/,
    );
    expect(() => ledgerFromJson("{not json")).toThrow(/Not valid JSON/);
  });

  it("defaults a posting currency to the document currency", () => {
    const document = {
      version: 1,
      currency: "GBP",
      accounts: [],
      entries: [
        {
          id: "JE-1",
          date: "2026-08-01",
          narration: "Rent",
          postings: [
            { account: "5300", amount: "10.00" },
            { account: "1110", amount: "-10.00" },
          ],
        },
      ],
    };
    expect(ledgerFromDocument(document).balanceOf("5300").currency.code).toBe("GBP");
  });
});
