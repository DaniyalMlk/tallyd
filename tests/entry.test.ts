import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  InvalidEntryError,
  JournalEntry,
  UnbalancedEntryError,
  isBalanced,
  residualsByCurrency,
} from "../src/ledger/entry.js";
import { InvalidDateError } from "../src/ledger/date.js";
import { GBP, Money, USD } from "../src/money/index.js";
import { standardChart } from "../src/accounts/index.js";

const gbp = (text: string) => Money.parse(text, GBP);
const usd = (text: string) => Money.parse(text, USD);
const chart = standardChart();

const sale = () =>
  JournalEntry.create({
    id: "e1",
    date: "2026-08-14",
    narration: "Invoice 1001 — Acme",
    postings: [
      { account: "1130", amount: gbp("1200.00"), memo: "Acme" },
      { account: "4100", amount: gbp("-1000.00") },
      { account: "2200", amount: gbp("-200.00"), memo: "VAT at 20%" },
    ],
    reference: "INV-1001",
    tags: ["sales"],
  });

describe("the balancing invariant", () => {
  it("accepts an entry whose postings sum to zero", () => {
    const entry = sale();
    expect(entry.postings).toHaveLength(3);
    expect(entry.total().toDecimalString()).toBe("1200.00");
  });

  it("rejects an entry that does not balance", () => {
    expect(() =>
      JournalEntry.create({
        id: "bad",
        date: "2026-08-14",
        narration: "Off by a penny",
        postings: [
          { account: "1110", amount: gbp("10.00") },
          { account: "4100", amount: gbp("-9.99") },
        ],
      }),
    ).toThrow(UnbalancedEntryError);
  });

  it("names the residual in the error", () => {
    try {
      JournalEntry.create({
        id: "bad",
        date: "2026-08-14",
        narration: "Off by a penny",
        postings: [
          { account: "1110", amount: gbp("10.00") },
          { account: "4100", amount: gbp("-9.99") },
        ],
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnbalancedEntryError);
      expect((error as UnbalancedEntryError).residuals[0]?.toDecimalString()).toBe("0.01");
    }
  });

  it("requires each currency to balance on its own", () => {
    expect(() =>
      JournalEntry.create({
        id: "fx",
        date: "2026-08-14",
        narration: "Cross-currency without a conversion account",
        postings: [
          { account: "1110", amount: gbp("100.00") },
          { account: "4100", amount: usd("-100.00") },
        ],
      }),
    ).toThrow(UnbalancedEntryError);
  });

  it("accepts a multi-currency entry where each currency balances", () => {
    const entry = JournalEntry.create({
      id: "fx-ok",
      date: "2026-08-14",
      narration: "Two currencies, both square",
      postings: [
        { account: "1110", amount: gbp("100.00") },
        { account: "4100", amount: gbp("-100.00") },
        { account: "1120", amount: usd("50.00") },
        { account: "4200", amount: usd("-50.00") },
      ],
    });
    expect(entry.isMultiCurrency).toBe(true);
    expect(entry.currencies.map((c) => c.code).sort()).toEqual(["GBP", "USD"]);
    expect(entry.total("USD").toDecimalString()).toBe("50.00");
  });

  it("cannot be unbalanced after construction", () => {
    const entry = sale();
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.postings)).toBe(true);
    expect(() => {
      (entry.postings as { length: number }).length = 0;
    }).toThrow();
  });
});

describe("entry validation", () => {
  it("requires at least two postings", () => {
    expect(() =>
      JournalEntry.create({
        id: "one",
        date: "2026-08-14",
        narration: "Single leg",
        postings: [{ account: "1110", amount: gbp("0.00") }],
      }),
    ).toThrow(/at least 2/);
  });

  it("rejects a zero-value posting", () => {
    expect(() =>
      JournalEntry.create({
        id: "zero",
        date: "2026-08-14",
        narration: "Zero leg",
        postings: [
          { account: "1110", amount: gbp("10.00") },
          { account: "4100", amount: gbp("-10.00") },
          { account: "1120", amount: gbp("0") },
        ],
      }),
    ).toThrow(/is for zero/);
  });

  it("rejects a blank id or narration", () => {
    const postings = [
      { account: "1110", amount: gbp("1.00") },
      { account: "4100", amount: gbp("-1.00") },
    ];
    expect(() =>
      JournalEntry.create({ id: " ", date: "2026-08-14", narration: "x", postings }),
    ).toThrow(InvalidEntryError);
    expect(() =>
      JournalEntry.create({ id: "x", date: "2026-08-14", narration: "  ", postings }),
    ).toThrow(InvalidEntryError);
  });

  it("rejects an invalid date", () => {
    expect(() =>
      JournalEntry.create({
        id: "x",
        date: "2026-02-30",
        narration: "Nope",
        postings: [
          { account: "1110", amount: gbp("1.00") },
          { account: "4100", amount: gbp("-1.00") },
        ],
      }),
    ).toThrow(InvalidDateError);
  });

  it("checks accounts against the chart when one is supplied", () => {
    const postings = [
      { account: "1110", amount: gbp("1.00") },
      { account: "9999", amount: gbp("-1.00") },
    ];
    expect(() =>
      JournalEntry.create({ id: "x", date: "2026-08-14", narration: "Bad account", postings }, chart),
    ).toThrow(/No such account: 9999/);
  });

  it("refuses to post to a placeholder", () => {
    expect(() =>
      JournalEntry.create(
        {
          id: "x",
          date: "2026-08-14",
          narration: "Posting to a header",
          postings: [
            { account: "1000", amount: gbp("1.00") },
            { account: "4100", amount: gbp("-1.00") },
          ],
        },
        chart,
      ),
    ).toThrow(/not postable/);
  });

  it("allows any account when no chart is supplied", () => {
    const entry = JournalEntry.create({
      id: "x",
      date: "2026-08-14",
      narration: "Chartless",
      postings: [
        { account: "whatever", amount: gbp("1.00") },
        { account: "other", amount: gbp("-1.00") },
      ],
    });
    expect(entry.accounts).toEqual(["whatever", "other"]);
  });
});

describe("simple entries", () => {
  it("builds a two-line entry from a debit and a credit", () => {
    const entry = JournalEntry.simple(
      {
        id: "s1",
        date: "2026-08-14",
        narration: "Rent",
        debit: "5300",
        credit: "1110",
        amount: gbp("950.00"),
        reference: "DD-3",
      },
      chart,
    );
    expect(entry.debits[0]?.account).toBe("5300");
    expect(entry.credits[0]?.account).toBe("1110");
    expect(entry.credits[0]?.amount.toDecimalString()).toBe("-950.00");
    expect(entry.reference).toBe("DD-3");
  });

  it("insists on a positive amount", () => {
    expect(() =>
      JournalEntry.simple({
        id: "s2",
        date: "2026-08-14",
        narration: "Backwards",
        debit: "5300",
        credit: "1110",
        amount: gbp("-950.00"),
      }),
    ).toThrow(/positive amount/);
  });
});

describe("accessors", () => {
  const entry = sale();

  it("separates debits from credits", () => {
    expect(entry.debits.map((p) => p.account)).toEqual(["1130"]);
    expect(entry.credits.map((p) => p.account)).toEqual(["4100", "2200"]);
  });

  it("reports the accounts it touches", () => {
    expect(entry.touches("4100")).toBe(true);
    expect(entry.touches("1110")).toBe(false);
    expect(entry.accounts).toEqual(["1130", "4100", "2200"]);
  });

  it("nets multiple postings to the same account", () => {
    const netted = JournalEntry.create({
      id: "n",
      date: "2026-08-14",
      narration: "Two legs on one account",
      postings: [
        { account: "1110", amount: gbp("100.00") },
        { account: "1110", amount: gbp("-30.00") },
        { account: "4100", amount: gbp("-70.00") },
      ],
    });
    expect(netted.amountFor("1110").toDecimalString()).toBe("70.00");
    expect(netted.accounts).toEqual(["1110", "4100"]);
  });

  it("returns zero for an untouched account", () => {
    expect(entry.amountFor("5300", GBP).isZero).toBe(true);
  });

  it("renders a readable summary", () => {
    expect(entry.toString()).toContain("2026-08-14 e1 Invoice 1001 — Acme");
    expect(entry.toString()).toContain("1130");
  });

  it("serialises to JSON with exact amounts", () => {
    const json = JSON.parse(JSON.stringify(entry)) as {
      postings: Array<{ amount: { amount: string; currency: string } }>;
    };
    expect(json.postings[0]?.amount).toEqual({ amount: "120000", currency: "GBP" });
  });
});

describe("reversal", () => {
  it("mirrors every posting and records the link", () => {
    const original = sale();
    const reversal = original.reversal({ id: "e1r", date: "2026-08-20" });
    expect(reversal.reverses).toBe("e1");
    expect(reversal.date).toBe("2026-08-20");
    expect(reversal.narration).toContain("Reversal of");
    expect(reversal.amountFor("1130").toDecimalString()).toBe("-1200.00");
    expect(reversal.reference).toBe("INV-1001");
  });

  it("cancels the original exactly", () => {
    const original = sale();
    const reversal = original.reversal({ id: "e1r", date: "2026-08-20" });
    for (const account of original.accounts) {
      const net = original.amountFor(account).plus(reversal.amountFor(account));
      expect(net.isZero).toBe(true);
    }
  });

  it("survives a double reversal back to the original amounts", () => {
    const original = sale();
    const back = original
      .reversal({ id: "r1", date: "2026-08-20" })
      .reversal({ id: "r2", date: "2026-08-21" });
    for (const account of original.accounts) {
      expect(back.amountFor(account).equals(original.amountFor(account))).toBe(true);
    }
  });
});

describe("residuals", () => {
  it("reports nothing for a balanced set", () => {
    expect(residualsByCurrency([gbp("1.00"), gbp("-1.00")])).toEqual([]);
    expect(isBalanced([gbp("1.00"), gbp("-1.00")])).toBe(true);
  });

  it("reports one residual per unbalanced currency", () => {
    const residuals = residualsByCurrency([gbp("1.00"), usd("-2.00"), gbp("-0.50")]);
    expect(residuals).toHaveLength(2);
    expect(residuals.map((r) => r.currency.code).sort()).toEqual(["GBP", "USD"]);
  });

  it("treats an empty set as balanced", () => {
    expect(isBalanced([])).toBe(true);
  });

  it("accepts any set built as pairs, and rejects any set with a stray unit", () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 10n ** 9n }), { minLength: 1, maxLength: 20 }),
        (magnitudes) => {
          const amounts = magnitudes.flatMap((m) => [
            Money.ofMinor(m, GBP),
            Money.ofMinor(-m, GBP),
          ]);
          expect(isBalanced(amounts)).toBe(true);
          expect(isBalanced([...amounts, Money.ofMinor(1n, GBP)])).toBe(false);
        },
      ),
    );
  });

  it("cannot be fooled by a set that balances only when currencies are ignored", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 9n }), (m) => {
        const amounts = [Money.ofMinor(m, GBP), Money.ofMinor(-m, USD)];
        expect(isBalanced(amounts)).toBe(false);
      }),
    );
  });
});
