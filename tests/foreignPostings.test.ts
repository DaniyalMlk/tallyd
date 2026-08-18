import { describe, expect, it } from "vitest";
import { ChartOfAccounts } from "../src/accounts/chart.js";
import { STANDARD_ACCOUNTS } from "../src/accounts/standard.js";
import { InvalidEntryError, JournalEntry } from "../src/ledger/entry.js";
import { Ledger } from "../src/ledger/ledger.js";
import { ledgerFromJson, ledgerToJson, LedgerDocumentError } from "../src/ledger/serialise.js";
import { trialBalance } from "../src/ledger/trialBalance.js";
import { EUR, GBP, USD } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";

export const MULTI_CURRENCY_CHART = ChartOfAccounts.build(
  [
    ...STANDARD_ACCOUNTS,
    { code: "1131", name: "Accounts Receivable (EUR)", type: "asset", parent: "1100", currency: "EUR" },
    { code: "2101", name: "Accounts Payable (USD)", type: "liability", parent: "2000", currency: "USD" },
  ],
  { currency: "GBP" },
);

/** 1,000 EUR invoiced when the euro bought 0.8400. */
function euroInvoice(): JournalEntry {
  return JournalEntry.create(
    {
      id: "INV-2026-014",
      date: "2026-01-20",
      narration: "Invoice — Blauwe Zee BV",
      reference: "INV-014",
      postings: [
        { account: "1131", amount: Money.parse("840.00", GBP), foreign: Money.parse("1000.00", EUR) },
        { account: "4200", amount: Money.parse("-840.00", GBP) },
      ],
    },
    MULTI_CURRENCY_CHART,
  );
}

describe("a posting that carries what actually moved", () => {
  it("keeps both figures", () => {
    const posting = euroInvoice().postings[0] as { amount: Money; foreign: Money | null };
    expect(posting.amount.toString()).toBe("840.00 GBP");
    expect((posting.foreign as Money).toString()).toBe("1000.00 EUR");
  });

  it("still balances in the functional currency alone", () => {
    const entry = euroInvoice();
    expect(entry.total(GBP).toString()).toBe("840.00 GBP");
    expect(entry.hasForeignAmounts).toBe(true);
    expect(entry.foreignCurrencies.map((c) => c.code)).toEqual(["EUR"]);
  });

  it("does not need the foreign side to balance, because a transaction has one side", () => {
    // The euro amount appears once. Requiring it to net to zero would mean
    // inventing a euro counterpart to a sterling revenue account.
    const entry = euroInvoice();
    expect(entry.foreignPostings).toHaveLength(1);
    expect(entry.foreignAmountFor("1131", EUR).toString()).toBe("1000.00 EUR");
    expect(entry.foreignAmountFor("4200", EUR).toString()).toBe("0.00 EUR");
  });

  it("leaves a trial balance in the functional currency alone", () => {
    const ledger = Ledger.from([euroInvoice()], MULTI_CURRENCY_CHART);
    const tb = trialBalance(ledger, { currency: GBP });
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit.toString()).toBe("840.00 GBP");
  });

  it("shows both figures when printed", () => {
    expect(euroInvoice().toString()).toContain("(1000.00 EUR)");
  });

  it("mirrors the foreign leg through a reversal", () => {
    const reversed = euroInvoice().reversal({ id: "REV-014", date: "2026-02-01" });
    const posting = reversed.postings[0] as { amount: Money; foreign: Money | null };
    expect(posting.amount.toString()).toBe("-840.00 GBP");
    expect((posting.foreign as Money).toString()).toBe("-1000.00 EUR");
  });
});

describe("what a foreign leg is not allowed to be", () => {
  function build(foreign: Money, amount = Money.parse("840.00", GBP), account = "1131") {
    return () =>
      JournalEntry.create(
        {
          id: "X",
          date: "2026-01-20",
          narration: "x",
          postings: [
            { account, amount, foreign },
            { account: "4200", amount: amount.negated() },
          ],
        },
        MULTI_CURRENCY_CHART,
      );
  }

  it("refuses zero", () => {
    expect(build(Money.zero(EUR))).toThrow(/foreign amount of zero/);
  });

  it("refuses the same currency as the posting", () => {
    expect(build(Money.parse("840.00", GBP))).toThrow(/as the foreign side of a GBP posting/);
  });

  it("refuses a sign that disagrees with the posting", () => {
    expect(build(Money.parse("-1000.00", EUR))).toThrow(/opposite sides/);
  });

  it("refuses a currency the account is not denominated in", () => {
    expect(build(Money.parse("1000.00", USD))).toThrow(/denominated in EUR, not USD/);
  });

  it("refuses a foreign leg on an account kept in the books' own currency", () => {
    expect(build(Money.parse("1000.00", EUR), Money.parse("840.00", GBP), "1110")).toThrow(
      /denominated in GBP, not EUR/,
    );
  });

  it("accepts a posting with no foreign leg on a foreign account, which is what a revaluation is", () => {
    const adjustment = JournalEntry.create(
      {
        id: "FX-1",
        date: "2026-03-31",
        narration: "Revaluation",
        postings: [
          { account: "1131", amount: Money.parse("7.30", GBP) },
          { account: "4400", amount: Money.parse("-7.30", GBP) },
        ],
      },
      MULTI_CURRENCY_CHART,
    );
    expect(adjustment.hasForeignAmounts).toBe(false);
  });
});

describe("the ledger document carries both figures", () => {
  it("round-trips an entry with a foreign leg", () => {
    const ledger = Ledger.from([euroInvoice()], MULTI_CURRENCY_CHART);
    const back = ledgerFromJson(ledgerToJson(ledger));
    const posting = (back.entry("INV-2026-014") as JournalEntry).postings[0] as {
      amount: Money;
      foreign: Money | null;
    };
    expect(posting.amount.toString()).toBe("840.00 GBP");
    expect((posting.foreign as Money).toString()).toBe("1000.00 EUR");
  });

  it("keeps the account's denomination in the document", () => {
    const document = JSON.parse(ledgerToJson(Ledger.from([euroInvoice()], MULTI_CURRENCY_CHART)));
    const account = document.accounts.find((a: { code: string }) => a.code === "1131");
    expect(account.currency).toBe("EUR");
  });

  it("omits the foreign key entirely when there is not one", () => {
    const plain = JournalEntry.simple(
      {
        id: "JE-1",
        date: "2026-01-01",
        narration: "Rent",
        debit: "5300",
        credit: "1110",
        amount: Money.parse("100.00", GBP),
      },
      MULTI_CURRENCY_CHART,
    );
    const document = JSON.parse(ledgerToJson(Ledger.from([plain], MULTI_CURRENCY_CHART)));
    expect(document.entries[0].postings[0]).not.toHaveProperty("foreign");
  });

  it("refuses a foreign amount given as a JSON number", () => {
    const document = JSON.parse(ledgerToJson(Ledger.from([euroInvoice()], MULTI_CURRENCY_CHART)));
    document.entries[0].postings[0].foreign.amount = 1000;
    expect(() => ledgerFromJson(JSON.stringify(document))).toThrow(LedgerDocumentError);
  });

  it("refuses a foreign leg that is not an object", () => {
    const document = JSON.parse(ledgerToJson(Ledger.from([euroInvoice()], MULTI_CURRENCY_CHART)));
    document.entries[0].postings[0].foreign = "1000.00 EUR";
    expect(() => ledgerFromJson(JSON.stringify(document))).toThrow(/must be an object/);
  });

  it("re-validates on load, so a document cannot smuggle in a bad foreign leg", () => {
    const document = JSON.parse(ledgerToJson(Ledger.from([euroInvoice()], MULTI_CURRENCY_CHART)));
    document.entries[0].postings[0].foreign.amount = "-1000.00";
    expect(() => ledgerFromJson(JSON.stringify(document))).toThrow(InvalidEntryError);
  });
});
