/**
 * The margin the group charged itself, and who gives it up.
 *
 * Two things in this adjustment are worth a test each rather than a comment.
 *
 * The first is that the rate is quoted two incompatible ways and the same
 * number means different money under each. Goods costing 80 sold at cost plus
 * a quarter fetch 100 and carry 20 of profit, which is a fifth of the price.
 * Taking a quarter of the price instead provides 25 against a profit that was
 * only ever 20, and the stock ends up carried below what it cost the group —
 * the opposite of the error being corrected, and the same size again. So both
 * forms are named, and the tests below check that the conversion between them
 * is right and that the two are visibly different where they are not the same
 * trade.
 *
 * The second is who bears it. The provision reverses a profit and the profit
 * belongs to whoever recorded it, so the charge follows the seller and not the
 * stock. That makes a parent selling down into a three-quarter-owned
 * subsidiary and that subsidiary selling up into the parent two different
 * adjustments with the same effect on inventory, which is the part that looks
 * wrong until you ask whose profit is being taken away. Both directions are
 * worked by hand here.
 */

import { describe, expect, it } from "vitest";
import { ChartOfAccounts } from "../src/accounts/chart.js";
import { STANDARD_ACCOUNTS } from "../src/accounts/standard.js";
import { JournalEntry } from "../src/ledger/entry.js";
import { Ledger } from "../src/ledger/ledger.js";
import { dateRange } from "../src/ledger/date.js";
import type { Currency } from "../src/money/currency.js";
import { EUR, GBP } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { RateTable } from "../src/fx/table.js";
import { GroupError, GroupStructure } from "../src/group/structure.js";
import { Interest } from "../src/group/interest.js";
import { aggregate } from "../src/group/aggregate.js";
import { CONSOLIDATION_ACCOUNTS, GROUP_ACCOUNTS } from "../src/group/accounts.js";
import { consolidate } from "../src/group/consolidate.js";
import {
  type IntragroupStockDeclaration,
  profitFractionOf,
  provideForUnrealisedProfit,
  renderUnrealisedProfit,
} from "../src/group/unrealised.js";

/**
 * The standard chart has no stock account, because a small business ledger
 * does not need one and guessing a code would write down an account nobody
 * named. One is added here, which is also what the module requires of a
 * caller: the account is declared, never defaulted.
 */
const STOCK = "1160";

function chartFor(currency: string): ChartOfAccounts {
  return ChartOfAccounts.build(
    [
      ...STANDARD_ACCOUNTS,
      ...CONSOLIDATION_ACCOUNTS,
      { code: STOCK, name: "Inventory", type: "asset", parent: "1100" },
    ],
    { currency },
  );
}

const GBP_CHART = chartFor("GBP");
const EUR_CHART = chartFor("EUR");

const RATES = RateTable.of(
  [
    { date: "2026-01-01", base: "EUR", quote: "GBP", rate: "0.8000" },
    { date: "2026-06-30", base: "EUR", quote: "GBP", rate: "0.8000" },
    { date: "2026-12-31", base: "EUR", quote: "GBP", rate: "0.8000" },
  ],
  { maxStaleDays: 400 },
);

const PERIOD = dateRange("2026-01-01", "2026-12-31");
const ASAT = "2026-12-31";

interface Leg {
  id: string;
  date: string;
  narration: string;
  debit: string;
  credit: string;
  amount: string;
}

function ledgerOf(chart: ChartOfAccounts, currency: Currency, legs: readonly Leg[]): Ledger {
  return Ledger.from(
    legs.map((leg) =>
      JournalEntry.simple(
        {
          id: leg.id,
          date: leg.date,
          narration: leg.narration,
          debit: leg.debit,
          credit: leg.credit,
          amount: Money.parse(leg.amount, currency),
        },
        chart,
      ),
    ),
    chart,
  );
}

const gbp = (text: string): Money => Money.parse(text, GBP);
const eur = (text: string): Money => Money.parse(text, EUR);

/**
 * P owns three quarters of S. Both keep sterling books.
 *
 * One of them sold the other 100,000 of goods at cost plus a quarter — so the
 * goods cost 80,000 and carry 20,000 of profit — and the buyer still has all
 * of them. `sellerIsSub` swaps which way round the trade went, leaving every
 * figure otherwise identical, because the point of the pair is that the
 * inventory adjustment is the same and the attribution is not.
 */
function books(sellerIsSub: boolean) {
  const seller = sellerIsSub ? "S" : "P";
  const buyer = sellerIsSub ? "P" : "S";

  const pLegs: Leg[] = [
    { id: "P-CAP", date: "2026-01-01", narration: "Capital", debit: "1110", credit: "3100", amount: "400000.00" },
    { id: "P-INV", date: "2026-01-01", narration: "Investment in S", debit: "1230", credit: "1110", amount: "90000.00" },
  ];
  const sLegs: Leg[] = [
    { id: "S-CAP", date: "2026-01-01", narration: "Capital", debit: "1110", credit: "3100", amount: "100000.00" },
  ];

  // The seller buys the goods in, then sells them on at a quarter over cost.
  // The buyer takes them into stock and owes the seller for them.
  const sellerLegs = seller === "P" ? pLegs : sLegs;
  const buyerLegs = buyer === "P" ? pLegs : sLegs;
  sellerLegs.push(
    { id: `${seller}-BUY`, date: "2026-06-01", narration: "Goods in", debit: STOCK, credit: "1110", amount: "80000.00" },
    { id: `${seller}-SELL`, date: "2026-06-30", narration: `Goods to ${buyer}`, debit: "1190", credit: "4950", amount: "100000.00" },
    { id: `${seller}-COS`, date: "2026-06-30", narration: "Cost of those goods", debit: "5100", credit: STOCK, amount: "80000.00" },
  );
  buyerLegs.push({
    id: `${buyer}-RECV`,
    date: "2026-06-30",
    narration: `Goods from ${seller}`,
    debit: STOCK,
    credit: "2190",
    amount: "100000.00",
  });

  return {
    P: ledgerOf(GBP_CHART, GBP, pLegs),
    S: ledgerOf(GBP_CHART, GBP, sLegs),
    seller,
    buyer,
  };
}

const GROUP = GroupStructure.build(
  [
    { code: "P", name: "Parent Ltd", currency: GBP },
    { code: "S", name: "Sub Ltd", currency: GBP, parent: "P", holding: "75" },
  ],
  { presentation: "GBP" },
);

function aggregationFor(ledgers: Record<string, Ledger>, group = GROUP) {
  return aggregate(group, ledgers, { rates: RATES, asAt: ASAT, period: PERIOD, historicalAccounts: ["1230"] });
}

/** The declaration for the fixture above, as either basis. */
type Overrides = {
  [K in keyof IntragroupStockDeclaration]?: IntragroupStockDeclaration[K] | undefined;
};

function declare(seller: string, holder: string, overrides: Overrides = {}): IntragroupStockDeclaration {
  const base: IntragroupStockDeclaration = {
    seller,
    holder,
    account: STOCK,
    onHand: gbp("100000.00"),
    basis: "markup-on-cost",
    rate: Interest.of(1n, 4n),
  };
  // Assigning `rate: undefined` is not the same as leaving `rate` out under
  // exactOptionalPropertyTypes, and the cost basis needs it genuinely absent.
  for (const [k, v] of Object.entries(overrides)) {
    const mutable = base as unknown as Record<string, unknown>;
    if (v === undefined) delete mutable[k];
    else mutable[k] = v;
  }
  return base;
}

describe("the rate is quoted two ways and they are not the same rate", () => {
  it("converts a markup on cost into its share of the selling price", () => {
    // Cost 4, price 5, profit 1: a quarter on cost is a fifth of the price.
    expect(profitFractionOf("markup-on-cost", Interest.of(1n, 4n)).equals(Interest.of(1n, 5n))).toBe(
      true,
    );
    // A third on cost is a quarter of the price, exactly. Through a decimal
    // this is 0.3333/(1.3333) = 0.249981…, which is a different number.
    expect(profitFractionOf("markup-on-cost", Interest.of(1n, 3n)).equals(Interest.of(1n, 4n))).toBe(
      true,
    );
    // And a sale at cost carries no profit to provide against.
    expect(profitFractionOf("markup-on-cost", Interest.none).isZero).toBe(true);
  });

  it("leaves a margin on the selling price alone", () => {
    expect(profitFractionOf("margin-on-price", Interest.of(1n, 4n)).equals(Interest.of(1n, 4n))).toBe(
      true,
    );
  });

  it("refuses a rate on the cost basis, which takes a cost", () => {
    expect(() => profitFractionOf("cost", Interest.of(1n, 4n))).toThrow(GroupError);
  });

  it("gives the same provision from a quarter on cost and a fifth on price", () => {
    const { P, S } = books(true);
    const aggregation = aggregationFor({ P, S });
    const markup = provideForUnrealisedProfit(GROUP, aggregation, [declare("S", "P")]);
    const margin = provideForUnrealisedProfit(GROUP, aggregation, [
      declare("S", "P", { basis: "margin-on-price", rate: Interest.of(1n, 5n) }),
    ]);
    expect(markup.totalProvision.equals(gbp("20000.00"))).toBe(true);
    expect(margin.totalProvision.equals(markup.totalProvision)).toBe(true);
  });

  it("gives a different provision from a quarter on cost and a quarter on price", () => {
    const { P, S } = books(true);
    const aggregation = aggregationFor({ P, S });
    const onCost = provideForUnrealisedProfit(GROUP, aggregation, [declare("S", "P")]);
    const onPrice = provideForUnrealisedProfit(GROUP, aggregation, [
      declare("S", "P", { basis: "margin-on-price", rate: Interest.of(1n, 4n) }),
    ]);
    expect(onCost.totalProvision.equals(gbp("20000.00"))).toBe(true);
    expect(onPrice.totalProvision.equals(gbp("25000.00"))).toBe(true);
    // 5,000 apart on 100,000 of stock. Not a rounding difference: reading one
    // convention as the other writes the goods down to 75,000 against a cost
    // to the group of 80,000.
    expect(onPrice.totalProvision.minus(onCost.totalProvision).equals(gbp("5000.00"))).toBe(true);
  });

  it("agrees with the cost the goods were bought in at, which converts nothing", () => {
    const { P, S } = books(true);
    const aggregation = aggregationFor({ P, S });
    const stated = provideForUnrealisedProfit(GROUP, aggregation, [
      declare("S", "P", { basis: "cost", rate: undefined, cost: gbp("80000.00") }),
    ]);
    expect(stated.totalProvision.equals(gbp("20000.00"))).toBe(true);
    // And it reports the fraction it worked out to, so the three bases are
    // comparable on the face of the result rather than only in the total.
    expect(stated.items[0]?.profitFraction.equals(Interest.of(1n, 5n))).toBe(true);
  });

  it("keeps a non-terminating rate exact rather than to four places", () => {
    const { P, S } = books(true);
    const aggregation = aggregationFor({ P, S });
    const third = provideForUnrealisedProfit(GROUP, aggregation, [
      declare("S", "P", { basis: "margin-on-price", rate: Interest.of(1n, 3n) }),
    ]);
    // A third of 100,000.00 is 33,333.33 and a third of a million would be
    // 333,333.33. Quoted as 0.3333 instead it comes to 33,330.00 here and
    // 333,300.00 there, so the error grows with the balance.
    expect(third.totalProvision.equals(gbp("33333.33"))).toBe(true);
    expect(
      Interest.of(3333n, 10000n).share(gbp("100000.00")).equals(gbp("33330.00")),
    ).toBe(true);
  });
});

describe("the charge follows the seller, not the stock", () => {
  it("gives the outside stake its share when its company made the sale", () => {
    const { P, S } = books(true);
    const aggregation = aggregationFor({ P, S });
    const provision = provideForUnrealisedProfit(GROUP, aggregation, [declare("S", "P")]);
    const item = provision.items[0];
    expect(item?.seller).toBe("S");
    expect(item?.holder).toBe("P");
    // 20,000 of margin, a quarter of S outside the group: 5,000 theirs.
    expect(provision.totalProvision.equals(gbp("20000.00"))).toBe(true);
    expect(provision.totalNciShare.equals(gbp("5000.00"))).toBe(true);
    expect(provision.totalGroupShare.equals(gbp("15000.00"))).toBe(true);
  });

  it("gives it none when its company only bought the goods", () => {
    const { P, S } = books(false);
    const aggregation = aggregationFor({ P, S });
    const provision = provideForUnrealisedProfit(GROUP, aggregation, [declare("P", "S")]);
    // The stock sits in S, which outsiders own a quarter of, and they bear
    // nothing: the margin was P's and P's own shareholders give all of it up.
    expect(provision.totalProvision.equals(gbp("20000.00"))).toBe(true);
    expect(provision.totalNciShare.isZero).toBe(true);
    expect(provision.totalGroupShare.equals(gbp("20000.00"))).toBe(true);
  });

  it("writes the same amount off stock whichever way the goods went", () => {
    const up = provideForUnrealisedProfit(
      GROUP,
      aggregationFor({ P: books(true).P, S: books(true).S }),
      [declare("S", "P")],
    );
    const down = provideForUnrealisedProfit(
      GROUP,
      aggregationFor({ P: books(false).P, S: books(false).S }),
      [declare("P", "S")],
    );
    expect(up.totalProvision.equals(down.totalProvision)).toBe(true);
    // The two differ only in who gives it up, which is the whole asymmetry.
    expect(up.totalNciShare.equals(down.totalNciShare)).toBe(false);
  });

  it("takes the outside stake's share out of its claim and not out of the expense", () => {
    const { P, S } = books(true);
    const aggregation = aggregationFor({ P, S });
    const provision = provideForUnrealisedProfit(GROUP, aggregation, [declare("S", "P")], {
      chart: GBP_CHART,
    });
    const entry = provision.entries[0];
    expect(entry).toBeDefined();
    const amountOn = (code: string): Money =>
      (entry as JournalEntry).postings
        .filter((p) => p.account === code)
        .reduce((running, p) => running.plus(p.amount), gbp("0.00"));
    // Stock down 20,000; the charge 15,000; the outside stake 5,000.
    expect(amountOn(STOCK).equals(gbp("-20000.00"))).toBe(true);
    expect(amountOn(GROUP_ACCOUNTS.unrealisedProfit).equals(gbp("15000.00"))).toBe(true);
    expect(amountOn(GROUP_ACCOUNTS.nonControllingInterest).equals(gbp("5000.00"))).toBe(true);
  });

  it("uses the complement of the chained interest for a company held through another", () => {
    const tiered = GroupStructure.build(
      [
        { code: "P", name: "Parent Ltd", currency: GBP },
        { code: "S", name: "Sub Ltd", currency: GBP, parent: "P", holding: "80" },
        { code: "T", name: "Sub-sub Ltd", currency: GBP, parent: "S", holding: "75" },
      ],
      { presentation: "GBP" },
    );
    // T sells 100,000 of goods to P at cost plus a quarter. P holds them all.
    const tLedger = ledgerOf(GBP_CHART, GBP, [
      { id: "T-CAP", date: "2026-01-01", narration: "Capital", debit: "1110", credit: "3100", amount: "100000.00" },
      { id: "T-BUY", date: "2026-06-01", narration: "Goods in", debit: STOCK, credit: "1110", amount: "80000.00" },
      { id: "T-SELL", date: "2026-06-30", narration: "Goods to P", debit: "1190", credit: "4950", amount: "100000.00" },
      { id: "T-COS", date: "2026-06-30", narration: "Cost of those goods", debit: "5100", credit: STOCK, amount: "80000.00" },
    ]);
    const pLedger = ledgerOf(GBP_CHART, GBP, [
      { id: "P-CAP", date: "2026-01-01", narration: "Capital", debit: "1110", credit: "3100", amount: "400000.00" },
      { id: "P-RECV", date: "2026-06-30", narration: "Goods from T", debit: STOCK, credit: "2190", amount: "100000.00" },
    ]);
    const sLedger = ledgerOf(GBP_CHART, GBP, [
      { id: "S-CAP", date: "2026-01-01", narration: "Capital", debit: "1110", credit: "3100", amount: "100000.00" },
    ]);
    const aggregation = aggregate(
      tiered,
      { P: pLedger, S: sLedger, T: tLedger },
      { rates: RATES, asAt: ASAT, period: PERIOD },
    );
    const provision = provideForUnrealisedProfit(tiered, aggregation, [declare("T", "P")]);
    // The group's effective interest in T is 80% of 75%, which is 60%, so the
    // outside stake is 40% — not the 20% outside S and not the 25% outside T.
    expect(provision.items[0]?.nonControlling.equals(Interest.of(2n, 5n))).toBe(true);
    expect(provision.totalNciShare.equals(gbp("8000.00"))).toBe(true);
    expect(provision.totalGroupShare.equals(gbp("12000.00"))).toBe(true);
  });
});

describe("what cannot be provided against is named", () => {
  it("refuses to write stock below nothing", () => {
    const { P, S } = books(true);
    const aggregation = aggregationFor({ P, S });
    // P carries 100,000 of the stock. A declaration claiming 500,000 of it was
    // on hand at a quarter margin would provide 125,000 against it.
    const provision = provideForUnrealisedProfit(GROUP, aggregation, [
      declare("S", "P", { onHand: gbp("500000.00"), basis: "margin-on-price", rate: Interest.of(1n, 4n) }),
    ]);
    expect(provision.items).toHaveLength(0);
    expect(provision.entries).toHaveLength(0);
    expect(provision.totalProvision.isZero).toBe(true);
    expect(provision.unprovided).toHaveLength(1);
    expect(provision.unprovided[0]?.reason).toContain("125000.00");
    expect(provision.unprovided[0]?.reason).toContain("100000.00");
  });

  it("adds the consignments in one account up before deciding that", () => {
    const { P, S } = books(true);
    const aggregation = aggregationFor({ P, S });
    // Three consignments of 60,000 at a quarter margin: 15,000 each, which any
    // one of them can afford against 100,000 of stock, and 45,000 together,
    // which they still can. A fourth takes it to 60,000 — still affordable.
    const affordable = provideForUnrealisedProfit(
      GROUP,
      aggregation,
      [1, 2, 3].map(() =>
        declare("S", "P", { onHand: gbp("60000.00"), basis: "margin-on-price", rate: Interest.of(1n, 4n) }),
      ),
    );
    expect(affordable.totalProvision.equals(gbp("45000.00"))).toBe(true);
    expect(affordable.unprovided).toHaveLength(0);

    // Eight of them is 120,000 against 100,000 carried. No one declaration
    // looks wrong; the account cannot carry them together, and the account is
    // the asset.
    const tooMany = provideForUnrealisedProfit(
      GROUP,
      aggregation,
      Array.from({ length: 8 }, () =>
        declare("S", "P", { onHand: gbp("60000.00"), basis: "margin-on-price", rate: Interest.of(1n, 4n) }),
      ),
    );
    expect(tooMany.items).toHaveLength(0);
    expect(tooMany.unprovided).toHaveLength(8);
    expect(tooMany.totalProvision.isZero).toBe(true);
  });

  it("says so when the holder is not being consolidated", () => {
    const withAssociate = GroupStructure.build(
      [
        { code: "P", name: "Parent Ltd", currency: GBP },
        { code: "S", name: "Sub Ltd", currency: GBP, parent: "P", holding: "75" },
        { code: "A", name: "Associate Ltd", currency: GBP, parent: "P", holding: "30" },
      ],
      { presentation: "GBP" },
    );
    const { P, S } = books(true);
    const aggregation = aggregate(
      withAssociate,
      { P, S },
      { rates: RATES, asAt: ASAT, period: PERIOD, historicalAccounts: ["1230"] },
    );
    const provision = provideForUnrealisedProfit(withAssociate, aggregation, [declare("S", "A")]);
    expect(provision.items).toHaveLength(0);
    expect(provision.unprovided[0]?.reason).toContain("not being consolidated");
  });

  it("posts no entry for a sale that carried no margin", () => {
    const { P, S } = books(true);
    const aggregation = aggregationFor({ P, S });
    const provision = provideForUnrealisedProfit(GROUP, aggregation, [
      declare("S", "P", { basis: "cost", rate: undefined, cost: gbp("100000.00") }),
    ]);
    expect(provision.items).toHaveLength(1);
    expect(provision.totalProvision.isZero).toBe(true);
    expect(provision.entries).toHaveLength(0);
  });

  it("rejects declarations that cannot mean anything", () => {
    const { P, S } = books(true);
    const aggregation = aggregationFor({ P, S });
    const attempt = (overrides: Overrides): (() => unknown) => () =>
      provideForUnrealisedProfit(GROUP, aggregation, [declare("S", "P", overrides)]);

    expect(attempt({ seller: "P", holder: "P" })).toThrow(/cannot sell stock to itself/);
    expect(attempt({ seller: "Z" })).toThrow(/not in the group/);
    expect(attempt({ holder: "Z" })).toThrow(/not in the group/);
    expect(attempt({ onHand: gbp("-1000.00") })).toThrow(/negative amount/);
    expect(attempt({ rate: undefined })).toThrow(/needs a rate/);
    expect(attempt({ basis: "cost", rate: undefined })).toThrow(/needs a cost/);
    // Goods sold at a loss are a write-down in the seller's own books, which
    // is a real event and not an elimination.
    expect(attempt({ basis: "cost", rate: undefined, cost: gbp("120000.00") })).toThrow(
      /a loss and not an unrealised profit/,
    );
    // A cost in another currency than the price is not a cost of these goods.
    expect(attempt({ basis: "cost", rate: undefined, cost: eur("80000.00") })).toThrow(
      /is in EUR and the stock on hand is in GBP/,
    );
  });
});

describe("a provision against books kept in another currency", () => {
  /** P holds 100,000 EUR of S's goods. S is the EUR company; P reports in GBP. */
  function foreignBooks() {
    const sLedger = ledgerOf(EUR_CHART, EUR, [
      { id: "S-CAP", date: "2026-01-01", narration: "Capital", debit: "1110", credit: "3100", amount: "250000.00" },
      { id: "S-BUY", date: "2026-06-01", narration: "Goods in", debit: STOCK, credit: "1110", amount: "80000.00" },
      { id: "S-SELL", date: "2026-06-30", narration: "Goods to P", debit: "1190", credit: "4950", amount: "100000.00" },
      { id: "S-COS", date: "2026-06-30", narration: "Cost", debit: "5100", credit: STOCK, amount: "80000.00" },
    ]);
    // P is the holder here, and reports in the presentation currency.
    const pLedger = ledgerOf(GBP_CHART, GBP, [
      { id: "P-CAP", date: "2026-01-01", narration: "Capital", debit: "1110", credit: "3100", amount: "400000.00" },
      { id: "P-RECV", date: "2026-06-30", narration: "Goods from S", debit: STOCK, credit: "2190", amount: "80000.00" },
    ]);
    return { P: pLedger, S: sLedger };
  }

  const FOREIGN = GroupStructure.build(
    [
      { code: "P", name: "Parent Ltd", currency: GBP },
      { code: "S", name: "Sub GmbH", currency: EUR, parent: "P", holding: "75" },
    ],
    { presentation: "GBP" },
  );

  it("restates a provision stated in the holder's currency at the stock's own rate", () => {
    // S holds the goods this time, so the stock being written down is in euros.
    const sLedger = ledgerOf(EUR_CHART, EUR, [
      { id: "S-CAP", date: "2026-01-01", narration: "Capital", debit: "1110", credit: "3100", amount: "250000.00" },
      { id: "S-RECV", date: "2026-06-30", narration: "Goods from P", debit: STOCK, credit: "2190", amount: "100000.00" },
    ]);
    const pLedger = ledgerOf(GBP_CHART, GBP, [
      { id: "P-CAP", date: "2026-01-01", narration: "Capital", debit: "1110", credit: "3100", amount: "400000.00" },
      { id: "P-BUY", date: "2026-06-01", narration: "Goods in", debit: STOCK, credit: "1110", amount: "64000.00" },
      { id: "P-SELL", date: "2026-06-30", narration: "Goods to S", debit: "1190", credit: "4950", amount: "80000.00" },
      { id: "P-COS", date: "2026-06-30", narration: "Cost", debit: "5100", credit: STOCK, amount: "64000.00" },
    ]);
    const aggregation = aggregate(
      FOREIGN,
      { P: pLedger, S: sLedger },
      { rates: RATES, asAt: ASAT, period: PERIOD },
    );
    const provision = provideForUnrealisedProfit(FOREIGN, aggregation, [
      declare("P", "S", { onHand: eur("100000.00") }),
    ]);
    const item = provision.items[0];
    // A fifth of 100,000 EUR is 20,000 EUR, which at 0.80 is 16,000 GBP.
    expect(item?.provision.equals(gbp("16000.00"))).toBe(true);
    expect(item?.onHandPresentation.equals(gbp("80000.00"))).toBe(true);
    // And the two legs are struck at the rate the stock row itself was
    // translated at, so the write-down is a fifth of the translated stock and
    // not a fifth of something else.
    expect(
      Interest.of(1n, 5n).share(item?.onHandPresentation as Money).equals(item?.provision as Money),
    ).toBe(true);
  });

  it("takes a provision already in the presentation currency as it stands", () => {
    const aggregation = aggregate(FOREIGN, foreignBooks(), {
      rates: RATES,
      asAt: ASAT,
      period: PERIOD,
    });
    const provision = provideForUnrealisedProfit(FOREIGN, aggregation, [
      declare("S", "P", { onHand: gbp("80000.00") }),
    ]);
    expect(provision.items[0]?.provision.equals(gbp("16000.00"))).toBe(true);
  });
});

describe("through a consolidation", () => {
  /**
   * P paid 90,000 for three quarters of S when S's net assets were 100,000, so
   * goodwill is 15,000 and the outside stake came in at 25,000.
   *
   * Only the balance-sheet pair is declared intercompany. Netting the sale
   * against the purchase is the elimination pass's job and is tested there;
   * leaving the trading in keeps this fixture about the one adjustment, and
   * the group's result is read off the accounts rather than assumed either way.
   */
  function run(sellerIsSub: boolean, withProvision: boolean) {
    const { P, S, seller, buyer } = books(sellerIsSub);
    return consolidate(
      GROUP,
      { P, S },
      {
        rates: RATES,
        asAt: ASAT,
        period: PERIOD,
        acquisitions: [
          { entity: "S", acquired: "2026-01-01", consideration: gbp("90000.00") },
        ],
        intercompany: [
          { entity: seller, account: "1190", counterparty: buyer, link: "trading" },
          { entity: buyer, account: "2190", counterparty: seller, link: "trading" },
        ],
        ...(withProvision
          ? { intragroupStock: [declare(seller, buyer, { holder: buyer, seller })] }
          : {}),
      },
    );
  }

  it("balances with the provision in it", () => {
    const result = run(true, true);
    expect(result.balanced).toBe(true);
    expect(result.residual.isZero).toBe(true);
    expect(result.unrealisedProfit.totalProvision.equals(gbp("20000.00"))).toBe(true);
  });

  it("takes the stock down by the whole provision and the claims down by their shares", () => {
    const before = run(true, false);
    const after = run(true, true);
    const stockOf = (r: ReturnType<typeof run>): Money => r.ledger.balanceOf(STOCK, GBP);
    // All 20,000 comes off the asset.
    expect(stockOf(before).minus(stockOf(after)).equals(gbp("20000.00"))).toBe(true);
    // A quarter of it comes off the outside stake, because S made the sale.
    expect(
      before.nonControllingInterest.minus(after.nonControllingInterest).equals(gbp("5000.00")),
    ).toBe(true);
    // The rest is charged, and shows as its own line rather than inside cost
    // of sales.
    expect(after.ledger.balanceOf(GROUP_ACCOUNTS.unrealisedProfit, GBP).equals(gbp("15000.00"))).toBe(
      true,
    );
    expect(before.ledger.balanceOf(GROUP_ACCOUNTS.unrealisedProfit, GBP).isZero).toBe(true);
  });

  it("leaves the outside stake alone when the parent was the seller", () => {
    const before = run(false, false);
    const after = run(false, true);
    const stockOf = (r: ReturnType<typeof run>): Money => r.ledger.balanceOf(STOCK, GBP);
    expect(stockOf(before).minus(stockOf(after)).equals(gbp("20000.00"))).toBe(true);
    expect(before.nonControllingInterest.equals(after.nonControllingInterest)).toBe(true);
    expect(after.ledger.balanceOf(GROUP_ACCOUNTS.unrealisedProfit, GBP).equals(gbp("20000.00"))).toBe(
      true,
    );
    expect(after.balanced).toBe(true);
  });

  it("is nil and harmless when nothing is declared", () => {
    const result = run(true, false);
    expect(result.unrealisedProfit.items).toHaveLength(0);
    expect(result.unrealisedProfit.entries).toHaveLength(0);
    expect(result.unrealisedProfit.totalProvision.isZero).toBe(true);
    expect(result.balanced).toBe(true);
  });

  it("validates the provision entries against the consolidated chart", () => {
    const result = run(true, true);
    const entry = result.unrealisedProfit.entries[0];
    expect(entry?.tags).toContain("unrealised-profit");
    // In the consolidated ledger, tagged and findable rather than folded into
    // another step's entry.
    expect(result.ledger.all().filter((e) => e.tags.includes("unrealised-profit"))).toHaveLength(1);
  });
});

describe("rendering", () => {
  it("says who bore it and what the rate came to", () => {
    const { P, S } = books(true);
    const provision = provideForUnrealisedProfit(GROUP, aggregationFor({ P, S }), [declare("S", "P")]);
    const text = renderUnrealisedProfit(provision);
    expect(text).toContain("S into P");
    expect(text).toContain("markup-on-cost");
    expect(text).toContain("20%");
    expect(text).toContain("20000.00");
    expect(text).toContain("15000.00");
    expect(text).toContain("5000.00");
  });

  it("says when all of it was the group's", () => {
    const { P, S } = books(false);
    const provision = provideForUnrealisedProfit(GROUP, aggregationFor({ P, S }), [declare("P", "S")]);
    const text = renderUnrealisedProfit(provision);
    expect(text).toContain("all of it the group's");
    expect(text).not.toContain("borne by the stakes outside");
  });

  it("names what it did not provide against", () => {
    const { P, S } = books(true);
    const provision = provideForUnrealisedProfit(GROUP, aggregationFor({ P, S }), [
      declare("S", "P", { onHand: gbp("900000.00") }),
    ]);
    expect(renderUnrealisedProfit(provision)).toContain("NOT PROVIDED");
  });
});
