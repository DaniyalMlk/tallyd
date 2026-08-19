import { describe, expect, it } from "vitest";
import { JournalEntry } from "../src/ledger/entry.js";
import { Ledger } from "../src/ledger/ledger.js";
import { dateRange } from "../src/ledger/date.js";
import type { ChartOfAccounts } from "../src/accounts/chart.js";
import type { Currency } from "../src/money/currency.js";
import { EUR, GBP, USD } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { RateTable } from "../src/fx/table.js";
import { balanceSheet } from "../src/reports/balanceSheet.js";
import { GroupError, GroupStructure } from "../src/group/structure.js";
import { Interest } from "../src/group/interest.js";
import { groupChart } from "../src/group/accounts.js";
import { acquisitionOf, netAssets, renderAcquisition } from "../src/group/acquisition.js";
import { consolidate, renderConsolidation } from "../src/group/consolidate.js";

const GBP_CHART = groupChart("GBP");
const EUR_CHART = groupChart("EUR");
const USD_CHART = groupChart("USD");

const PERIOD = dateRange("2026-01-01", "2026-12-31");

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

// ---------------------------------------------------------------------------
// A sterling parent and a sterling subsidiary, so nothing turns on a rate.
//
//   P subscribes 200,000 of capital and pays 48,000 for 80% of S.
//   S was formed with 50,000 of capital; nothing else had happened when P
//   bought it, so the net assets acquired were 50,000.
//   By the reporting date S has 20,000 of reserves brought forward and has
//   made 5,000 this year on 30,000 of sales.
//
// Worked by hand:
//   NCI at acquisition, proportionate  = 20% x 50,000 = 10,000
//   Goodwill                           = 48,000 + 10,000 - 50,000 = 8,000
//   Net assets now                     = 50,000 + 20,000 + 5,000 = 75,000
//   NCI at the reporting date          = 20% x 75,000 = 15,000
//   NCI share of this year's profit    = 20% x 5,000 = 1,000
//   Group's post-acquisition reserves  = 80% x 20,000 = 16,000
// ---------------------------------------------------------------------------

const PARENT = ledgerOf(GBP_CHART, GBP, [
  { id: "P-CAP", date: "2024-12-31", narration: "Capital", debit: "1110", credit: "3100", amount: "200000.00" },
  { id: "P-INV", date: "2025-01-01", narration: "Bought 80% of S", debit: "1230", credit: "1110", amount: "48000.00" },
]);

const SUB = ledgerOf(GBP_CHART, GBP, [
  { id: "S-CAP", date: "2024-12-31", narration: "Capital", debit: "1110", credit: "3100", amount: "50000.00" },
  { id: "S-RES", date: "2025-06-30", narration: "Reserves brought forward", debit: "1110", credit: "3200", amount: "20000.00" },
  { id: "S-INC", date: "2026-06-30", narration: "Sales", debit: "1110", credit: "4100", amount: "30000.00" },
  { id: "S-EXP", date: "2026-06-30", narration: "Cost of sales", debit: "5100", credit: "1110", amount: "25000.00" },
]);

const SIMPLE = GroupStructure.build(
  [
    { code: "P", name: "Parent Ltd", currency: GBP },
    { code: "S", name: "Sub Ltd", currency: GBP, parent: "P", holding: "80", acquired: "2025-01-01" },
  ],
  { presentation: "GBP", name: "The Group" },
);

const SIMPLE_LEDGERS = { P: PARENT, S: SUB };

function simple(overrides: Record<string, unknown> = {}) {
  return consolidate(SIMPLE, SIMPLE_LEDGERS, {
    rates: RateTable.empty(),
    asAt: "2026-12-31",
    period: PERIOD,
    acquisitions: [{ entity: "S", consideration: Money.parse("48000.00", GBP) }],
    ...overrides,
  });
}

describe("net assets are read off the books on the day control was obtained", () => {
  it("is assets less liabilities and nothing else", () => {
    expect(netAssets(SUB, "2025-01-01" as never, GBP).toDecimalString()).toBe("50000.00");
    expect(netAssets(SUB, "2026-12-31" as never, GBP).toDecimalString()).toBe("75000.00");
  });

  it("ignores what happened after the date asked for", () => {
    expect(netAssets(SUB, "2025-12-31" as never, GBP).toDecimalString()).toBe("70000.00");
  });
});

describe("goodwill, worked by hand", () => {
  const acquisition = () =>
    acquisitionOf(
      SIMPLE,
      SIMPLE_LEDGERS,
      { entity: "S", consideration: Money.parse("48000.00", GBP) },
      { rates: RateTable.empty(), presentation: GBP },
    );

  it("measures the outside stake proportionately by default", () => {
    const a = acquisition();
    expect(a.measurement).toBe("proportionate");
    expect(a.nciAtAcquisition.toDecimalString()).toBe("10000.00");
    expect(a.nciGoodwill.isZero).toBe(true);
  });

  it("is the consideration plus the outside stake less the net assets", () => {
    const a = acquisition();
    expect(a.netAssetsAcquired.toDecimalString()).toBe("50000.00");
    expect(a.goodwill.toDecimalString()).toBe("8000.00");
    expect(a.bargainGain.isZero).toBe(true);
  });

  it("carries the outside stake's own goodwill when it is measured at fair value", () => {
    const a = acquisitionOf(
      SIMPLE,
      SIMPLE_LEDGERS,
      {
        entity: "S",
        consideration: Money.parse("48000.00", GBP),
        nciMeasurement: "fair-value",
        nciFairValue: Money.parse("12000.00", GBP),
      },
      { rates: RateTable.empty(), presentation: GBP },
    );
    // 48,000 + 12,000 - 50,000 = 10,000, of which 12,000 - 10,000 = 2,000 is
    // the goodwill belonging to the outside shareholders.
    expect(a.goodwill.toDecimalString()).toBe("10000.00");
    expect(a.nciGoodwill.toDecimalString()).toBe("2000.00");
  });

  it("calls a price below the net assets a gain and not a negative asset", () => {
    const a = acquisitionOf(
      SIMPLE,
      SIMPLE_LEDGERS,
      { entity: "S", consideration: Money.parse("35000.00", GBP) },
      { rates: RateTable.empty(), presentation: GBP },
    );
    // 35,000 + 10,000 - 50,000 = -5,000.
    expect(a.goodwill.isZero).toBe(true);
    expect(a.bargainGain.toDecimalString()).toBe("5000.00");
  });

  it("takes a supplied figure for the net assets when the books do not carry it", () => {
    const a = acquisitionOf(
      SIMPLE,
      SIMPLE_LEDGERS,
      {
        entity: "S",
        consideration: Money.parse("48000.00", GBP),
        netAssetsAtAcquisition: Money.parse("55000.00", GBP),
      },
      { rates: RateTable.empty(), presentation: GBP },
    );
    expect(a.netAssetsSupplied).toBe(true);
    // 48,000 + 20% x 55,000 - 55,000 = 4,000.
    expect(a.goodwill.toDecimalString()).toBe("4000.00");
  });

  it("refuses fair value without a figure, and a figure without fair value", () => {
    expect(() =>
      acquisitionOf(
        SIMPLE,
        SIMPLE_LEDGERS,
        { entity: "S", consideration: Money.parse("1.00", GBP), nciMeasurement: "fair-value" },
        { rates: RateTable.empty(), presentation: GBP },
      ),
    ).toThrow(/supply nciFairValue/);
    expect(() =>
      acquisitionOf(
        SIMPLE,
        SIMPLE_LEDGERS,
        {
          entity: "S",
          consideration: Money.parse("1.00", GBP),
          nciFairValue: Money.parse("1.00", GBP),
        },
        { rates: RateTable.empty(), presentation: GBP },
      ),
    ).toThrow(/Say which is meant/);
  });

  it("refuses to account for the acquisition of the parent company", () => {
    expect(() =>
      acquisitionOf(
        SIMPLE,
        SIMPLE_LEDGERS,
        { entity: "P", consideration: Money.parse("1.00", GBP) },
        { rates: RateTable.empty(), presentation: GBP },
      ),
    ).toThrow(/nobody acquired it/);
  });

  it("refuses without a date, because there is no pre-acquisition without one", () => {
    const undated = GroupStructure.build([
      { code: "P", name: "P", currency: GBP },
      { code: "S", name: "S", currency: GBP, parent: "P", holding: "80" },
    ]);
    expect(() =>
      acquisitionOf(
        undated,
        SIMPLE_LEDGERS,
        { entity: "S", consideration: Money.parse("1.00", GBP) },
        { rates: RateTable.empty(), presentation: GBP },
      ),
    ).toThrow(/date control was obtained/);
  });

  it("refuses to consolidate an entity with no acquisition behind it", () => {
    expect(() =>
      consolidate(SIMPLE, SIMPLE_LEDGERS, {
        rates: RateTable.empty(),
        asAt: "2026-12-31",
        period: PERIOD,
      }),
    ).toThrow(/No acquisition for S/);
  });

  it("renders the arithmetic in the order it was worked", () => {
    const text = renderAcquisition(acquisition());
    expect(text).toContain("Consideration transferred");
    expect(text).toContain("Goodwill");
    expect(text).toContain("80% to the group");
  });
});

describe("the consolidated books, worked by hand", () => {
  it("balances, with a nil equation residual", () => {
    const result = simple();
    expect(result.balanced).toBe(true);
    expect(result.residual.isZero).toBe(true);
    result.ledger.verify();
  });

  it("carries the goodwill and the outside stake at the figures worked above", () => {
    const result = simple();
    expect(result.goodwill.toDecimalString()).toBe("8000.00");
    expect(result.nonControllingInterest.toDecimalString()).toBe("15000.00");
  });

  it("splits this year's profit between the two sides", () => {
    const working = simple().workings[0]!;
    expect(working.profitForPeriod.toDecimalString()).toBe("5000.00");
    expect(working.nciProfitShare.toDecimalString()).toBe("1000.00");
    expect(working.netAssetsNow.toDecimalString()).toBe("75000.00");
  });

  it("credits the group with its share of the reserves earned since it took control", () => {
    const working = simple().workings[0]!;
    expect(working.postAcquisitionReserves.toDecimalString()).toBe("16000.00");
    expect(working.equityRemoved.toDecimalString()).toBe("-70000.00");
  });

  it("makes the balancing figure equal the identity it should", () => {
    // The group's share of (the equity removed plus the net assets acquired).
    const working = simple().workings[0]!;
    const identity = working.acquisition.groupInterest.share(
      working.equityRemoved.plus(working.acquisition.netAssetsAcquired),
    );
    expect(identity.negated().equals(working.postAcquisitionReserves)).toBe(true);
  });

  it("leaves nothing of the investment or the subsidiary's own capital", () => {
    const result = simple();
    expect(result.investmentResidual.isZero).toBe(true);
    // The parent's own 200,000 survives; the subsidiary's 50,000 does not.
    expect(result.ledger.balanceOf("3100").toDecimalString()).toBe("-200000.00");
    expect(result.ledger.balanceOf("3200").toDecimalString()).toBe("-16000.00");
  });

  it("shows the outside stake's share of profit as an allocation, not a cost", () => {
    const result = simple();
    expect(result.ledger.balanceOf("3410").toDecimalString()).toBe("1000.00");
    expect(result.chart.get("3410").type).toBe("equity");
    // Consolidated revenue and cost are unaffected by the split.
    expect(result.ledger.balanceOf("4100").toDecimalString()).toBe("-30000.00");
    expect(result.ledger.balanceOf("5100").toDecimalString()).toBe("25000.00");
  });

  it("adds up on the face of the balance sheet", () => {
    const result = simple();
    const sheet = balanceSheet(result.ledger, result.asAt, { currency: GBP });
    // Cash 152,000 + 75,000 = 227,000, plus 8,000 of goodwill.
    expect(result.ledger.balanceOf("1110").toDecimalString()).toBe("227000.00");
    expect(sheet.balanced).toBe(true);
  });

  it("names every step in the ledger it produced", () => {
    const result = simple();
    expect(result.ledger.all().map((e) => e.id).sort()).toEqual([
      "CONS-S",
      "NCI-S",
      "TB-P",
      "TB-S",
    ]);
    for (const entry of result.ledger.all()) {
      expect(entry.tags).toContain("consolidation");
    }
  });

  it("books a bargain purchase as income", () => {
    const result = simple({
      acquisitions: [{ entity: "S", consideration: Money.parse("35000.00", GBP) }],
    });
    expect(result.goodwill.isZero).toBe(true);
    expect(result.bargainGain.toDecimalString()).toBe("5000.00");
    expect(result.ledger.balanceOf("4960").toDecimalString()).toBe("-5000.00");
    expect(result.balanced).toBe(true);
  });

  it("reports an investment the books carry at something other than the price", () => {
    const result = simple({
      acquisitions: [{ entity: "S", consideration: Money.parse("40000.00", GBP) }],
    });
    expect(result.investmentResidual.toDecimalString()).toBe("8000.00");
    expect(renderConsolidation(result)).toContain("Investment left uneliminated");
  });

  it("gives the whole of a wholly-owned subsidiary to the group", () => {
    const whole = GroupStructure.build([
      { code: "P", name: "P", currency: GBP },
      { code: "S", name: "S", currency: GBP, parent: "P", acquired: "2025-01-01" },
    ]);
    const result = consolidate(whole, SIMPLE_LEDGERS, {
      rates: RateTable.empty(),
      asAt: "2026-12-31",
      period: PERIOD,
      acquisitions: [{ entity: "S", consideration: Money.parse("48000.00", GBP) }],
    });
    expect(result.nonControllingInterest.isZero).toBe(true);
    // 48,000 for the whole of 50,000 of net assets is a bargain purchase.
    expect(result.goodwill.isZero).toBe(true);
    expect(result.bargainGain.toDecimalString()).toBe("2000.00");
    expect(result.workings[0]?.postAcquisitionReserves.toDecimalString()).toBe("20000.00");
  });
});

// ---------------------------------------------------------------------------
// Three currencies and an indirect holding, at one flat rate so the figures
// stay checkable: EUR/GBP and USD/GBP both 0.50 on every date that matters.
//
//   P (GBP) holds 80% of S (EUR); S holds 75% of T (USD).
//   The group's interest in T is 60% and the outside stake is 40% — which is
//   neither 20% nor 25%, the two numbers the individual links offer.
// ---------------------------------------------------------------------------

const FLAT = RateTable.of(
  [
    { date: "2024-01-01", base: "EUR", quote: "GBP", rate: "0.5000" },
    { date: "2026-12-31", base: "EUR", quote: "GBP", rate: "0.5000" },
    { date: "2024-01-01", base: "USD", quote: "GBP", rate: "0.5000" },
    { date: "2026-12-31", base: "USD", quote: "GBP", rate: "0.5000" },
  ],
  { maxStaleDays: 2000 },
);

const CHAIN = GroupStructure.build(
  [
    { code: "P", name: "Parent Ltd", currency: GBP },
    { code: "S", name: "Sub GmbH", currency: EUR, parent: "P", holding: "80", acquired: "2025-01-01" },
    { code: "T", name: "Third Inc", currency: USD, parent: "S", holding: "75", acquired: "2025-01-01" },
  ],
  { presentation: "GBP", name: "Chain Group" },
);

const CHAIN_LEDGERS = {
  P: ledgerOf(GBP_CHART, GBP, [
    { id: "P-CAP", date: "2024-12-31", narration: "Capital", debit: "1110", credit: "3100", amount: "300000.00" },
    { id: "P-INV", date: "2025-01-01", narration: "80% of S", debit: "1230", credit: "1110", amount: "60000.00" },
  ]),
  S: ledgerOf(EUR_CHART, EUR, [
    { id: "S-CAP", date: "2024-12-31", narration: "Capital", debit: "1110", credit: "3100", amount: "100000.00" },
    { id: "S-INV", date: "2025-01-01", narration: "75% of T", debit: "1230", credit: "1110", amount: "40000.00" },
    { id: "S-INC", date: "2026-06-30", narration: "Sales", debit: "1110", credit: "4100", amount: "20000.00" },
  ]),
  T: ledgerOf(USD_CHART, USD, [
    { id: "T-CAP", date: "2024-12-31", narration: "Capital", debit: "1110", credit: "3100", amount: "40000.00" },
    { id: "T-INC", date: "2026-06-30", narration: "Sales", debit: "1110", credit: "4100", amount: "10000.00" },
  ]),
};

function chain() {
  return consolidate(CHAIN, CHAIN_LEDGERS, {
    rates: FLAT,
    asAt: "2026-12-31",
    period: PERIOD,
    averageMethod: "quoted",
    acquisitions: [
      { entity: "S", consideration: Money.parse("60000.00", GBP) },
      { entity: "T", consideration: Money.parse("40000.00", EUR) },
    ],
  });
}

describe("a company held through another", () => {
  it("gives the outside stake the effective share and not either link's", () => {
    const result = chain();
    const third = result.workings.find((w) => w.entity === "T")!;
    expect(third.acquisition.groupInterest.toPercentString()).toBe("60%");
    expect(third.acquisition.nonControllingInterest.toPercentString()).toBe("40%");
  });

  it("measures its goodwill against what the subsidiary paid", () => {
    const result = chain();
    const third = result.workings.find((w) => w.entity === "T")!;
    // T's net assets at 2025-01-01 are 40,000 USD, or 20,000 GBP at 0.50.
    // S paid 40,000 EUR, or 20,000 GBP. The outside 40% is 8,000.
    expect(third.acquisition.netAssetsAcquired.toDecimalString()).toBe("20000.00");
    expect(third.acquisition.consideration.toDecimalString()).toBe("20000.00");
    expect(third.acquisition.nciAtAcquisition.toDecimalString()).toBe("8000.00");
    expect(third.acquisition.goodwill.toDecimalString()).toBe("8000.00");
  });

  it("gives the outside stake 40% of the third company's result", () => {
    const result = chain();
    const third = result.workings.find((w) => w.entity === "T")!;
    // 10,000 USD of sales is 5,000 GBP; 40% of it is 2,000.
    expect(third.profitForPeriod.toDecimalString()).toBe("5000.00");
    expect(third.nciProfitShare.toDecimalString()).toBe("2000.00");
    // Net assets now are 50,000 USD = 25,000 GBP; 40% is 10,000.
    expect(third.nciClosing.toDecimalString()).toBe("10000.00");
  });

  it("balances with three currencies and a chain in it", () => {
    const result = chain();
    expect(result.balanced).toBe(true);
    expect(result.residual.isZero).toBe(true);
    result.ledger.verify();
  });

  it("eliminates the middle company's investment as well as the parent's", () => {
    const result = chain();
    expect(result.investmentResidual.isZero).toBe(true);
    expect(result.ledger.balanceOf("3100").toDecimalString()).toBe("-300000.00");
  });

  it("adds the two outside stakes together", () => {
    const result = chain();
    const inS = result.workings.find((w) => w.entity === "S")!;
    const inT = result.workings.find((w) => w.entity === "T")!;
    expect(result.nonControllingInterest.equals(inS.nciClosing.plus(inT.nciClosing))).toBe(true);
  });

  it("splits the group's equity from the outside stake's without a gap", () => {
    const result = chain();
    const assets = result.trialBalance.rows
      .filter((r) => r.type === "asset" || r.type === "liability")
      .reduce((running, r) => running.plus(r.signed), Money.zero(GBP));
    const claims = result.trialBalance.rows
      .filter((r) => r.type !== "asset" && r.type !== "liability")
      .reduce((running, r) => running.plus(r.signed), Money.zero(GBP));
    expect(assets.plus(claims).isZero).toBe(true);
  });
});

describe("what a consolidation will not do", () => {
  it("refuses an acquisition declared twice", () => {
    expect(() =>
      simple({
        acquisitions: [
          { entity: "S", consideration: Money.parse("48000.00", GBP) },
          { entity: "S", consideration: Money.parse("1.00", GBP) },
        ],
      }),
    ).toThrow(/acquired twice/);
  });

  it("refuses an acquisition of a company it does not consolidate", () => {
    const withAssociate = GroupStructure.build([
      { code: "P", name: "P", currency: GBP },
      { code: "A", name: "Associate", currency: GBP, parent: "P", holding: "30", acquired: "2025-01-01" },
    ]);
    expect(() =>
      consolidate(withAssociate, { P: PARENT }, {
        rates: RateTable.empty(),
        asAt: "2026-12-31",
        period: PERIOD,
        acquisitions: [{ entity: "A", consideration: Money.parse("1.00", GBP) }],
      }),
    ).toThrow(/not consolidated/);
  });

  it("consolidates a group of one without complaint", () => {
    const alone = GroupStructure.build([{ code: "P", name: "P", currency: GBP }]);
    const result = consolidate(alone, { P: PARENT }, {
      rates: RateTable.empty(),
      asAt: "2026-12-31",
      period: PERIOD,
    });
    expect(result.balanced).toBe(true);
    expect(result.workings).toEqual([]);
    expect(result.nonControllingInterest.isZero).toBe(true);
  });

  it("keeps an account no group chart has ever heard of", () => {
    const result = simple();
    expect(result.chart.has("1230")).toBe(true);
    expect(result.chart.has("5100")).toBe(true);
  });
});

describe("rendering the consolidation", () => {
  it("shows the workings and the group's position", () => {
    const text = renderConsolidation(simple());
    expect(text).toContain("The Group — consolidated as at 2026-12-31 in GBP");
    expect(text).toContain("Non-controlling interest");
    expect(text).toContain("Accounting equation residual");
    expect(text).not.toContain("DOES NOT BALANCE");
  });

  it("reports the interest as an exact percentage", () => {
    expect(renderConsolidation(chain())).toContain("60% to the group");
  });
});

describe("the interest arithmetic reaches the money", () => {
  it("splits an odd amount without losing a penny", () => {
    const third = Interest.of(1n, 3n);
    const { mine, theirs } = third.splitOf(Money.ofMinor(100n, GBP));
    expect(mine.plus(theirs).minorUnits).toBe(100n);
  });

  it("refuses an acquisition where the group has no books to read", () => {
    expect(() =>
      acquisitionOf(
        SIMPLE,
        { P: PARENT },
        { entity: "S", consideration: Money.parse("1.00", GBP) },
        { rates: RateTable.empty(), presentation: GBP },
      ),
    ).toThrow(GroupError);
  });
});
