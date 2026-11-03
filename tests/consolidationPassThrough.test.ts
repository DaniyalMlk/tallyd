/**
 * The two option bags a consolidation hands down, driven from the top.
 *
 * `consolidate` owns the order of the adjustments and hands each pass its own
 * options. Two of those bags — the elimination pass's and the unrealised
 * profit pass's — had tests of their own against the pass that reads them, and
 * nothing had ever set either *through* a consolidation. That is a different
 * claim: it is the pass-through, the `chart` and `rounding` that
 * `consolidate` overrides on the caller's behalf, and the question of whether
 * a figure the caller redirected still reaches the consolidated ledger.
 *
 * The fixture is the smallest group that can show it. P owns three quarters of
 * S, both keep sterling books, and one sold the other goods it still holds —
 * so there is an intercompany pair to eliminate and a margin to provide for.
 * The pair is deliberately a few pence out, because a tolerance cannot be
 * tested against two sides that already agree.
 */

import { describe, expect, it } from "vitest";
import { ChartOfAccounts } from "../src/accounts/chart.js";
import { STANDARD_ACCOUNTS } from "../src/accounts/standard.js";
import { JournalEntry } from "../src/ledger/entry.js";
import { Ledger } from "../src/ledger/ledger.js";
import { dateRange } from "../src/ledger/date.js";
import { GBP } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { RateTable } from "../src/fx/table.js";
import { GroupStructure } from "../src/group/structure.js";
import { Interest } from "../src/group/interest.js";
import { CONSOLIDATION_ACCOUNTS, GROUP_ACCOUNTS } from "../src/group/accounts.js";
import { consolidate, type ConsolidationOptions } from "../src/group/consolidate.js";

const STOCK = "1160";
/** The standard chart has no stock account; one is declared rather than defaulted. */
const CHART = ChartOfAccounts.build(
  [
    ...STANDARD_ACCOUNTS,
    ...CONSOLIDATION_ACCOUNTS,
    { code: STOCK, name: "Inventory", type: "asset", parent: "1100" },
  ],
  { currency: "GBP" },
);
const PERIOD = dateRange("2026-01-01", "2026-12-31");
const ASAT = "2026-12-31";
const RATES = RateTable.of([], { maxStaleDays: 400 });

const gbp = (text: string): Money => Money.parse(text, GBP);

interface Leg {
  readonly id: string;
  readonly date: string;
  readonly narration: string;
  readonly debit: string;
  readonly credit: string;
  readonly amount: string;
}

function ledgerOf(legs: readonly Leg[]): Ledger {
  return Ledger.from(
    legs.map((leg) =>
      JournalEntry.simple(
        {
          id: leg.id,
          date: leg.date,
          narration: leg.narration,
          debit: leg.debit,
          credit: leg.credit,
          amount: Money.parse(leg.amount, GBP),
        },
        CHART,
      ),
    ),
    CHART,
  );
}

/**
 * S sold P goods costing 80,000 for 100,000, and P still holds them.
 *
 * `outBy` is added to what P says it owes, so the two sides of the
 * intercompany pair differ by that much. Three pence is the kind of difference
 * rounding a translated balance leaves behind, which is what the tolerance
 * exists for.
 */
function books(outBy: string) {
  const p: Leg[] = [
    { id: "P-CAP", date: "2026-01-01", narration: "Capital", debit: "1110", credit: "3100", amount: "400000.00" },
    { id: "P-INV", date: "2026-01-01", narration: "Investment in S", debit: "1230", credit: "1110", amount: "90000.00" },
    { id: "P-RECV", date: "2026-06-30", narration: "Goods from S", debit: STOCK, credit: "2190", amount: "100000.00" },
  ];
  if (outBy !== "0.00") {
    p.push({
      id: "P-EXTRA",
      date: "2026-12-30",
      narration: "Carriage charged on by S",
      debit: "5100",
      credit: "2190",
      amount: outBy,
    });
  }
  const s: Leg[] = [
    { id: "S-CAP", date: "2026-01-01", narration: "Capital", debit: "1110", credit: "3100", amount: "100000.00" },
    { id: "S-BUY", date: "2026-06-01", narration: "Goods in", debit: STOCK, credit: "1110", amount: "80000.00" },
    { id: "S-SELL", date: "2026-06-30", narration: "Goods to P", debit: "1190", credit: "4950", amount: "100000.00" },
    { id: "S-COS", date: "2026-06-30", narration: "Cost of those goods", debit: "5100", credit: STOCK, amount: "80000.00" },
  ];
  return { P: ledgerOf(p), S: ledgerOf(s) };
}

const GROUP = GroupStructure.build(
  [
    { code: "P", name: "Parent Ltd", currency: GBP },
    { code: "S", name: "Sub Ltd", currency: GBP, parent: "P", holding: "75" },
  ],
  { presentation: "GBP" },
);

function run(outBy: string, extra: Partial<ConsolidationOptions> = {}) {
  const { P, S } = books(outBy);
  return consolidate(
    GROUP,
    { P, S },
    {
      rates: RATES,
      asAt: ASAT,
      period: PERIOD,
      acquisitions: [{ entity: "S", acquired: "2026-01-01", consideration: gbp("90000.00") }],
      intercompany: [
        { entity: "S", account: "1190", counterparty: "P", link: "trading" },
        { entity: "P", account: "2190", counterparty: "S", link: "trading" },
      ],
      intragroupStock: [
        {
          seller: "S",
          holder: "P",
          account: STOCK,
          onHand: gbp("100000.00"),
          basis: "markup-on-cost" as const,
          rate: Interest.of(1n, 4n),
        },
      ],
      ...extra,
    },
  );
}

describe("the fixture is what the tests below assume", () => {
  it("balances, eliminates the pair and provides for the margin", () => {
    const result = run("0.00");
    expect(result.balanced).toBe(true);
    expect(result.eliminations.pairs).toHaveLength(1);
    expect(result.eliminations.pairs[0]?.agrees).toBe(true);
    expect(result.unrealisedProfit.totalProvision.equals(gbp("20000.00"))).toBe(true);
  });

  it("is three pence out when asked to be, and says so", () => {
    const result = run("0.03");
    expect(result.eliminations.pairs[0]?.agrees).toBe(false);
    // Negative: `difference` is positive when the group carries more asset
    // than liability, and here it is P's payable that is the larger side.
    expect(result.eliminations.pairs[0]?.difference.toDecimalString()).toBe("-0.03");
    expect(result.eliminations.totalDifference.toDecimalString()).toBe("-0.03");
    expect(result.balanced).toBe(true);
  });
});

describe("the elimination options reach the elimination pass", () => {
  it("carries a tolerance, which turns a disagreement into agreement", () => {
    const strict = run("0.03");
    const tolerant = run("0.03", { elimination: { tolerance: gbp("0.05") } });

    expect(strict.eliminations.pairs[0]?.agrees).toBe(false);
    expect(tolerant.eliminations.pairs[0]?.agrees).toBe(true);
    // The difference does not vanish — it is still three pence and still
    // booked. What the tolerance changes is whether anybody is asked about it.
    expect(tolerant.eliminations.pairs[0]?.difference.toDecimalString()).toBe("-0.03");
    expect(tolerant.balanced).toBe(true);
  });

  it("carries a tolerance that is too small to cover the difference", () => {
    // The other side of the same option: a tolerance below the gap leaves the
    // pair flagged, so the one above is not passing for some other reason.
    const tolerant = run("0.03", { elimination: { tolerance: gbp("0.01") } });
    expect(tolerant.eliminations.pairs[0]?.agrees).toBe(false);
  });

  it("carries a difference account, and the three pence land in it", () => {
    const standard = run("0.03");
    const redirected = run("0.03", { elimination: { differenceAccount: "1195" } });

    // 1195 is the default, so this pair has to agree — it is the control for
    // the pair below it.
    expect(
      standard.ledger.balanceOf(GROUP_ACCOUNTS.itemsInTransit, GBP).toDecimalString(),
    ).toBe(redirected.ledger.balanceOf("1195", GBP).toDecimalString());
    expect(standard.ledger.balanceOf("1195", GBP).abs().toDecimalString()).toBe("0.03");

    // Redirected to an account the group actually uses. The consolidated
    // chart is built from the accounts in the aggregation plus the
    // consolidation set, so the choice is not free: Petty Cash is in the
    // standard chart, no entity has touched it, and it is refused.
    const elsewhere = run("0.03", { elimination: { differenceAccount: "1110" } });
    expect(elsewhere.ledger.balanceOf("1195", GBP).isZero).toBe(true);
    expect(elsewhere.balanced).toBe(true);
    // The three pence moved rather than disappearing: the bank carries the
    // group's cash either way, so it is the change in it that shows this.
    const moved = elsewhere.ledger
      .balanceOf("1110", GBP)
      .minus(standard.ledger.balanceOf("1110", GBP));
    expect(moved.abs().toDecimalString()).toBe("0.03");
    expect(
      standard.ledger.balanceOf("1195", GBP).abs().equals(moved.abs()),
    ).toBe(true);
    expect(() => run("0.03", { elimination: { differenceAccount: "1120" } })).toThrow(
      /No such account: 1120/,
    );
  });

  it("carries an id prefix onto the entries it generates", () => {
    const result = run("0.03", { elimination: { idPrefix: "XELIM" } });
    const ids = result.eliminations.entries.map((entry) => entry.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id.startsWith("XELIM")).toBe(true);
    // And the entries reached the consolidated ledger under those ids, rather
    // than being renumbered on the way in.
    for (const id of ids) expect(result.ledger.has(id)).toBe(true);
  });
});

describe("the unrealised profit options reach that pass", () => {
  it("carries a charge account, and the whole charge moves to it", () => {
    const standard = run("0.00");
    const intoCostOfSales = run("0.00", { unrealisedProfit: { chargeAccount: "5100" } });

    // The group's share of the margin — three quarters of 20,000 is borne by
    // the outside stake's own claim, so 15,000 is charged.
    const charge = gbp("15000.00");
    expect(standard.ledger.balanceOf(GROUP_ACCOUNTS.unrealisedProfit, GBP).equals(charge)).toBe(true);

    const costOfSalesBefore = standard.ledger.balanceOf("5100", GBP);
    const costOfSalesAfter = intoCostOfSales.ledger.balanceOf("5100", GBP);
    expect(costOfSalesAfter.minus(costOfSalesBefore).equals(charge)).toBe(true);
    // And its own line is now empty, so the charge moved rather than doubling.
    expect(intoCostOfSales.ledger.balanceOf(GROUP_ACCOUNTS.unrealisedProfit, GBP).isZero).toBe(true);
  });

  it("leaves every other figure where it was", () => {
    // Which account the charge sits in is a presentation decision. The stock,
    // the outside stake and the group's result are the same either way.
    const standard = run("0.00");
    const moved = run("0.00", { unrealisedProfit: { chargeAccount: "5100" } });

    expect(moved.ledger.balanceOf(STOCK, GBP).toDecimalString()).toBe(
      standard.ledger.balanceOf(STOCK, GBP).toDecimalString(),
    );
    expect(moved.nonControllingInterest.toDecimalString()).toBe(
      standard.nonControllingInterest.toDecimalString(),
    );
    expect(moved.unrealisedProfit.totalProvision.toDecimalString()).toBe("20000.00");
    expect(moved.unrealisedProfit.totalGroupShare.toDecimalString()).toBe("15000.00");
    expect(moved.balanced).toBe(true);
    // The figures above are not nil agreeing with nil.
    // S's 80,000 left its books with the sale; P holds the goods at the
    // 100,000 it was charged, less the 20,000 the group never earned.
    expect(standard.ledger.balanceOf(STOCK, GBP).toDecimalString()).toBe("80000.00");
    expect(standard.nonControllingInterest.isZero).toBe(false);
  });

  it("carries an id prefix onto the provision entries", () => {
    const result = run("0.00", { unrealisedProfit: { idPrefix: "XPUP" } });
    const ids = result.unrealisedProfit.entries.map((entry) => entry.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id.startsWith("XPUP")).toBe(true);
    for (const id of ids) expect(result.ledger.has(id)).toBe(true);
  });

  it("refuses a charge account the consolidated chart does not hold", () => {
    // The pass validates its entries against the chart `consolidate` builds,
    // which the caller does not get to replace here — so a redirected charge
    // is checked rather than taken on trust.
    expect(() => run("0.00", { unrealisedProfit: { chargeAccount: "9999" } })).toThrow();
  });
});
