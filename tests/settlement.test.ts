import { describe, expect, it } from "vitest";
import { ChartOfAccounts } from "../src/accounts/chart.js";
import { STANDARD_ACCOUNTS } from "../src/accounts/standard.js";
import { JournalEntry } from "../src/ledger/entry.js";
import { Ledger } from "../src/ledger/ledger.js";
import { trialBalance } from "../src/ledger/trialBalance.js";
import { EUR, GBP, USD } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { rate } from "../src/fx/rate.js";
import { RateTable } from "../src/fx/table.js";
import { type Exposure, exposures } from "../src/fx/exposure.js";
import { applyRevaluation } from "../src/fx/revaluation.js";
import { SettlementError, applySettlement, settleForeignItem } from "../src/fx/settlement.js";

const CHART = ChartOfAccounts.build(
  [
    ...STANDARD_ACCOUNTS,
    { code: "1131", name: "Accounts Receivable (EUR)", type: "asset", parent: "1100", currency: "EUR" },
    { code: "2101", name: "Accounts Payable (USD)", type: "liability", parent: "2000", currency: "USD" },
  ],
  { currency: "GBP" },
);

const RATES = RateTable.of(
  [
    { date: "2026-01-20", base: "EUR", quote: "GBP", rate: "0.8400" },
    { date: "2026-01-20", base: "USD", quote: "GBP", rate: "0.7800" },
    { date: "2026-03-31", base: "EUR", quote: "GBP", rate: "0.8600" },
    { date: "2026-03-31", base: "USD", quote: "GBP", rate: "0.7700" },
    { date: "2026-04-20", base: "EUR", quote: "GBP", rate: "0.8700" },
    { date: "2026-04-20", base: "USD", quote: "GBP", rate: "0.7600" },
  ],
  { maxStaleDays: 5 },
);

/** A 1,000 EUR invoice raised on 20 January, when the euro bought 0.8400. */
function receivable(): Ledger {
  return Ledger.from(
    [
      JournalEntry.create({
        id: "INV-014",
        date: "2026-01-20",
        narration: "Invoice — Blauwe Zee BV",
        reference: "INV-014",
        postings: [
          { account: "1131", amount: Money.parse("840.00", GBP), foreign: Money.parse("1000.00", EUR) },
          { account: "4200", amount: Money.parse("-840.00", GBP) },
        ],
      }),
    ],
    CHART,
  );
}

/** A 500 USD bill on the same day, when the dollar bought 0.7800. */
function payable(): Ledger {
  return Ledger.from(
    [
      JournalEntry.create({
        id: "BILL-221",
        date: "2026-01-20",
        narration: "Bill — Redwood Systems Inc",
        reference: "BILL-221",
        postings: [
          { account: "5400", amount: Money.parse("390.00", GBP) },
          { account: "2101", amount: Money.parse("-390.00", GBP), foreign: Money.parse("-500.00", USD) },
        ],
      }),
    ],
    CHART,
  );
}

describe("settling a receivable", () => {
  it("realises the difference between the invoice rate and the receipt rate", () => {
    const settled = settleForeignItem(receivable(), {
      id: "RCT-014",
      date: "2026-04-20",
      account: "1131",
      bankAccount: "1110",
      rates: RATES,
    });
    expect(settled.settled.toString()).toBe("1000.00 EUR");
    expect(settled.carriedAt.toString()).toBe("840.00 GBP");
    expect(settled.received.toString()).toBe("870.00 GBP");
    expect(settled.realised.toString()).toBe("30.00 GBP");
    expect(settled.full).toBe(true);
  });

  it("clears both the euro balance and the sterling carrying amount", () => {
    const after = applySettlement(receivable(), {
      id: "RCT-014",
      date: "2026-04-20",
      account: "1131",
      bankAccount: "1110",
      rates: RATES,
    });
    const remaining = exposures(after, { includeSettled: true })[0] as Exposure;
    expect(remaining.foreignBalance.toString()).toBe("0.00 EUR");
    expect(remaining.carryingAmount.toString()).toBe("0.00 GBP");
    expect(trialBalance(after, { currency: GBP }).balanced).toBe(true);
  });

  it("puts what actually arrived in the bank", () => {
    const settled = settleForeignItem(receivable(), {
      id: "RCT-014",
      date: "2026-04-20",
      account: "1131",
      bankAccount: "1110",
      rates: RATES,
    });
    expect(settled.entry.amountFor("1110").toString()).toBe("870.00 GBP");
    expect(settled.entry.amountFor("4400").toString()).toBe("-30.00 GBP");
    expect(settled.entry.tags).toEqual(["fx", "realised"]);
  });

  it("books a loss when the rate went the other way", () => {
    const weaker = RateTable.of([
      { date: "2026-01-20", base: "EUR", quote: "GBP", rate: "0.8400" },
      { date: "2026-04-20", base: "EUR", quote: "GBP", rate: "0.8100" },
    ]);
    const settled = settleForeignItem(receivable(), {
      id: "RCT-014",
      date: "2026-04-20",
      account: "1131",
      bankAccount: "1110",
      rates: weaker,
    });
    expect(settled.realised.toString()).toBe("-30.00 GBP");
    expect(settled.entry.amountFor("5950").toString()).toBe("30.00 GBP");
  });

  it("books nothing to the P&L when the rate did not move", () => {
    const flat = RateTable.of([{ date: "2026-01-20", base: "EUR", quote: "GBP", rate: "0.8400" }], {
      maxStaleDays: 200,
    });
    const settled = settleForeignItem(receivable(), {
      id: "RCT-014",
      date: "2026-04-20",
      account: "1131",
      bankAccount: "1110",
      rates: flat,
    });
    expect(settled.realised.isZero).toBe(true);
    expect(settled.entry.postings).toHaveLength(2);
  });

  it("takes an explicit rate over the table", () => {
    const settled = settleForeignItem(receivable(), {
      id: "RCT-014",
      date: "2026-04-20",
      account: "1131",
      bankAccount: "1110",
      rate: rate("0.9000", EUR, GBP),
    });
    expect(settled.received.toString()).toBe("900.00 GBP");
    expect(settled.realised.toString()).toBe("60.00 GBP");
  });

  it("takes what the bank actually credited, and implies the rate from it", () => {
    // The bank converted at its own rate and kept a spread; 864.20 is what
    // landed, and pretending it was 870.00 would leave the account short.
    const settled = settleForeignItem(receivable(), {
      id: "RCT-014",
      date: "2026-04-20",
      account: "1131",
      bankAccount: "1110",
      settledFor: Money.parse("864.20", GBP),
    });
    expect(settled.received.toString()).toBe("864.20 GBP");
    expect(settled.realised.toString()).toBe("24.20 GBP");
    expect(settled.rate.toDecimalString(4)).toBe("0.8642");
  });
});

describe("settling a payable", () => {
  it("realises a loss when the currency owed has strengthened", () => {
    const stronger = RateTable.of([
      { date: "2026-01-20", base: "USD", quote: "GBP", rate: "0.7800" },
      { date: "2026-04-20", base: "USD", quote: "GBP", rate: "0.8000" },
    ]);
    const settled = settleForeignItem(payable(), {
      id: "PMT-221",
      date: "2026-04-20",
      account: "2101",
      bankAccount: "1110",
      rates: stronger,
    });
    expect(settled.settled.toString()).toBe("-500.00 USD");
    expect(settled.carriedAt.toString()).toBe("-390.00 GBP");
    expect(settled.received.toString()).toBe("-400.00 GBP");
    expect(settled.realised.toString()).toBe("-10.00 GBP");
    expect(settled.entry.amountFor("1110").toString()).toBe("-400.00 GBP");
    expect(settled.entry.amountFor("2101").toString()).toBe("390.00 GBP");
  });

  it("realises a gain when the currency owed has weakened", () => {
    const settled = settleForeignItem(payable(), {
      id: "PMT-221",
      date: "2026-04-20",
      account: "2101",
      bankAccount: "1110",
      rates: RATES,
    });
    // 500 USD at 0.7600 costs 380.00 to settle a 390.00 liability.
    expect(settled.realised.toString()).toBe("10.00 GBP");
    expect(settled.entry.amountFor("4400").toString()).toBe("-10.00 GBP");
  });

  it("clears the balance to nothing on both sides", () => {
    const after = applySettlement(payable(), {
      id: "PMT-221",
      date: "2026-04-20",
      account: "2101",
      bankAccount: "1110",
      rates: RATES,
    });
    const remaining = exposures(after, { includeSettled: true })[0] as Exposure;
    expect(remaining.foreignBalance.isZero).toBe(true);
    expect(remaining.carryingAmount.isZero).toBe(true);
  });
});

describe("the revaluation and the settlement have to agree", () => {
  it("counts the movement once when a revaluation happened in between", () => {
    // Invoiced at 0.8400, revalued at the March close of 0.8600, received in
    // April at 0.8700. The total is 30.00; the split is 20.00 unrealised in
    // the first quarter and 10.00 realised in the second.
    const revalued = applyRevaluation(receivable(), { asAt: "2026-03-31", rates: RATES });
    const settled = settleForeignItem(revalued, {
      id: "RCT-014",
      date: "2026-04-20",
      account: "1131",
      bankAccount: "1110",
      rates: RATES,
    });
    expect(settled.carriedAt.toString()).toBe("860.00 GBP");
    expect(settled.realised.toString()).toBe("10.00 GBP");

    const after = revalued.post(settled.entry);
    const gain = after.accountBalance("4400", "GBP").natural;
    expect(gain.toString()).toBe("30.00 GBP");
  });

  it("reaches the same P&L whether or not the interim revaluation was posted", () => {
    const withReval = applyRevaluation(receivable(), { asAt: "2026-03-31", rates: RATES });
    const a = applySettlement(withReval, {
      id: "RCT-014",
      date: "2026-04-20",
      account: "1131",
      bankAccount: "1110",
      rates: RATES,
    });
    const b = applySettlement(receivable(), {
      id: "RCT-014",
      date: "2026-04-20",
      account: "1131",
      bankAccount: "1110",
      rates: RATES,
    });
    expect(a.accountBalance("4400", "GBP").natural.toString()).toBe("30.00 GBP");
    expect(b.accountBalance("4400", "GBP").natural.toString()).toBe("30.00 GBP");
    expect(a.accountBalance("1110", "GBP").balance.toString()).toBe(
      b.accountBalance("1110", "GBP").balance.toString(),
    );
  });

  it("leaves nothing to revalue afterwards", () => {
    const after = applySettlement(
      applyRevaluation(receivable(), { asAt: "2026-03-31", rates: RATES }),
      { id: "RCT-014", date: "2026-04-20", account: "1131", bankAccount: "1110", rates: RATES },
    );
    expect(exposures(after)).toHaveLength(0);
  });
});

describe("part of a balance", () => {
  it("takes its share of the carrying amount pro rata", () => {
    const settled = settleForeignItem(receivable(), {
      id: "RCT-014a",
      date: "2026-04-20",
      account: "1131",
      bankAccount: "1110",
      amount: Money.parse("400.00", EUR),
      rates: RATES,
    });
    expect(settled.full).toBe(false);
    expect(settled.carriedAt.toString()).toBe("336.00 GBP");
    expect(settled.received.toString()).toBe("348.00 GBP");
    expect(settled.realised.toString()).toBe("12.00 GBP");
  });

  it("leaves the rest carried at the rate it was carried at before", () => {
    const after = applySettlement(receivable(), {
      id: "RCT-014a",
      date: "2026-04-20",
      account: "1131",
      bankAccount: "1110",
      amount: Money.parse("400.00", EUR),
      rates: RATES,
    });
    const rest = exposures(after)[0] as Exposure;
    expect(rest.foreignBalance.toString()).toBe("600.00 EUR");
    expect(rest.carryingAmount.toString()).toBe("504.00 GBP");
    expect(rest.impliedRate?.toDecimalString(4)).toBe("0.8400");
  });

  it("clears the balance exactly when the instalments finish", () => {
    let ledger = receivable();
    for (const [index, amount] of ["333.33", "333.33", "333.34"].entries()) {
      ledger = applySettlement(ledger, {
        id: `RCT-014-${index}`,
        date: "2026-04-20",
        account: "1131",
        bankAccount: "1110",
        amount: Money.parse(amount, EUR),
        rates: RATES,
      });
    }
    const remaining = exposures(ledger, { includeSettled: true })[0] as Exposure;
    expect(remaining.foreignBalance.isZero).toBe(true);
    expect(remaining.carryingAmount.isZero).toBe(true);
    expect(trialBalance(ledger, { currency: GBP }).balanced).toBe(true);
  });

  it("refuses to settle more than is outstanding", () => {
    expect(() =>
      settleForeignItem(receivable(), {
        id: "RCT-014",
        date: "2026-04-20",
        account: "1131",
        bankAccount: "1110",
        amount: Money.parse("1500.00", EUR),
        rates: RATES,
      }),
    ).toThrow(/Cannot settle 1500.00 EUR against an outstanding 1000.00 EUR/);
  });
});

describe("settling one invoice out of several", () => {
  function twoInvoices(): Ledger {
    return receivable().record({
      id: "INV-021",
      date: "2026-02-10",
      narration: "Invoice — Blauwe Zee BV",
      reference: "INV-021",
      postings: [
        { account: "1131", amount: Money.parse("425.00", GBP), foreign: Money.parse("500.00", EUR) },
        { account: "4200", amount: Money.parse("-425.00", GBP) },
      ],
    });
  }

  it("measures against the rate that invoice was booked at, not the account's blend", () => {
    const settled = settleForeignItem(twoInvoices(), {
      id: "RCT-021",
      date: "2026-04-20",
      account: "1131",
      bankAccount: "1110",
      reference: "INV-021",
      rates: RATES,
    });
    expect(settled.settled.toString()).toBe("500.00 EUR");
    expect(settled.carriedAt.toString()).toBe("425.00 GBP");
    expect(settled.carryingRate.toDecimalString(4)).toBe("0.8500");
    expect(settled.received.toString()).toBe("435.00 GBP");
    expect(settled.realised.toString()).toBe("10.00 GBP");
  });

  it("leaves the other invoice where it was", () => {
    const after = applySettlement(twoInvoices(), {
      id: "RCT-021",
      date: "2026-04-20",
      account: "1131",
      bankAccount: "1110",
      reference: "INV-021",
      rates: RATES,
    });
    const rest = exposures(after)[0] as Exposure;
    expect(rest.foreignBalance.toString()).toBe("1000.00 EUR");
    expect(rest.carryingAmount.toString()).toBe("840.00 GBP");
  });

  it("carries the reference onto the settlement entry", () => {
    const settled = settleForeignItem(twoInvoices(), {
      id: "RCT-021",
      date: "2026-04-20",
      account: "1131",
      bankAccount: "1110",
      reference: "INV-021",
      rates: RATES,
    });
    expect(settled.entry.reference).toBe("INV-021");
  });
});

describe("what settlement refuses", () => {
  const base = {
    id: "RCT-1",
    date: "2026-04-20",
    account: "1131",
    bankAccount: "1110",
    rates: RATES,
  };
  const rateless = { id: "RCT-1", date: "2026-04-20", account: "1131", bankAccount: "1110" };

  it("refuses an account with nothing on it", () => {
    expect(() => settleForeignItem(Ledger.empty(CHART), base)).toThrow(SettlementError);
  });

  it("refuses a reference nothing carries", () => {
    expect(() => settleForeignItem(receivable(), { ...base, reference: "INV-999" })).toThrow(
      /carries the reference INV-999/,
    );
  });

  it("refuses a balance already settled", () => {
    const cleared = applySettlement(receivable(), base);
    expect(() => settleForeignItem(cleared, { ...base, id: "RCT-2" })).toThrow(/already settled/);
  });

  it("refuses an amount in the wrong currency", () => {
    expect(() =>
      settleForeignItem(receivable(), { ...base, amount: Money.parse("500.00", USD) }),
    ).toThrow(/denominated in EUR, not USD/);
  });

  it("refuses a rate for the wrong pair", () => {
    expect(() =>
      settleForeignItem(receivable(), { ...rateless, rate: rate("1.28", GBP, USD) }),
    ).toThrow(/needs a EUR\/GBP rate, got GBP\/USD/);
  });

  it("refuses to guess when given neither a rate nor a table", () => {
    expect(() => settleForeignItem(receivable(), rateless)).toThrow(
      /needs a rate, a rate table, or the amount received/,
    );
  });

  it("says which pair it could not price", () => {
    const empty = RateTable.of([{ date: "2026-04-20", base: "USD", quote: "GBP", rate: "0.76" }]);
    expect(() => settleForeignItem(receivable(), { ...base, rates: empty })).toThrow(
      /No EUR\/GBP rate available/,
    );
  });
});
