import { describe, expect, it } from "vitest";
import { JournalEntry } from "../src/ledger/entry.js";
import { Ledger } from "../src/ledger/ledger.js";
import type { ChartOfAccounts } from "../src/accounts/chart.js";
import type { Currency } from "../src/money/currency.js";
import { EUR, GBP } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { RateTable } from "../src/fx/table.js";
import { GroupError, GroupStructure } from "../src/group/structure.js";
import { groupChart } from "../src/group/accounts.js";
import { type Acquisition, acquisitionOf, netAssets } from "../src/group/acquisition.js";

const GBP_CHART = groupChart("GBP");
const EUR_CHART = groupChart("EUR");

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
        { ...leg, amount: Money.parse(leg.amount, currency) },
        chart,
      ),
    ),
    chart,
  );
}

// ---------------------------------------------------------------------------
// A sterling parent and a subsidiary that keeps its books in euro.
//
// Unlike every other group fixture in this suite, the rate here MOVES. The
// others hold EUR/GBP at 0.50 on every date that matters, which keeps their
// hand-worked figures checkable and means nothing in them can see a
// translation take the wrong rate.
//
//   S was formed with 60,000 EUR of capital and nothing else had happened
//   when P bought 80% of it on 2025-01-01 for 80,000 GBP.
//   EUR/GBP was 0.80 that day, so the price was 100,000 EUR.
//
// Worked by hand, in euro, which is the currency the arithmetic belongs in:
//   Consideration                     = 80,000 GBP / 0.80  = 100,000 EUR
//   NCI at acquisition, proportionate = 20% x 60,000       =  12,000 EUR
//   Goodwill                          = 100,000 + 12,000 - 60,000
//                                                          =  52,000 EUR
//   Goodwill at the acquisition rate  = 52,000 x 0.80       =  41,600 GBP
// ---------------------------------------------------------------------------

const PARENT = ledgerOf(GBP_CHART, GBP, [
  { id: "P-CAP", date: "2024-12-31", narration: "Capital", debit: "1110", credit: "3100", amount: "500000.00" },
  { id: "P-INV", date: "2025-01-01", narration: "Bought 80% of S", debit: "1230", credit: "1110", amount: "80000.00" },
]);

const SUB = ledgerOf(EUR_CHART, EUR, [
  { id: "S-CAP", date: "2024-12-31", narration: "Capital", debit: "1110", credit: "3100", amount: "60000.00" },
  { id: "S-RES", date: "2025-06-30", narration: "Reserves brought forward", debit: "1110", credit: "3200", amount: "20000.00" },
  { id: "S-INC", date: "2026-06-30", narration: "Sales", debit: "1110", credit: "4100", amount: "40000.00" },
  { id: "S-EXP", date: "2026-06-30", narration: "Cost of sales", debit: "5100", credit: "1110", amount: "30000.00" },
]);

/** EUR/GBP at 0.80 through 2025, drifting to 0.90 by the end of 2026. */
export const MOVING_RATES = RateTable.of(
  [
    { date: "2024-12-01", base: "EUR", quote: "GBP", rate: "0.8000" },
    { date: "2024-12-31", base: "EUR", quote: "GBP", rate: "0.8000" },
    { date: "2025-06-30", base: "EUR", quote: "GBP", rate: "0.8000" },
    { date: "2025-12-31", base: "EUR", quote: "GBP", rate: "0.8000" },
    { date: "2026-01-31", base: "EUR", quote: "GBP", rate: "0.8200" },
    { date: "2026-03-31", base: "EUR", quote: "GBP", rate: "0.8400" },
    { date: "2026-06-30", base: "EUR", quote: "GBP", rate: "0.8500" },
    { date: "2026-09-30", base: "EUR", quote: "GBP", rate: "0.8700" },
    { date: "2026-12-31", base: "EUR", quote: "GBP", rate: "0.9000" },
  ],
  { maxStaleDays: 400 },
);

export const FOREIGN_GROUP = GroupStructure.build(
  [
    { code: "P", name: "Parent Ltd", currency: GBP },
    { code: "S", name: "Sub GmbH", currency: EUR, parent: "P", holding: "80", acquired: "2025-01-01" },
  ],
  { presentation: "GBP", name: "Cross-border Group" },
);

export const FOREIGN_LEDGERS = { P: PARENT, S: SUB };

export const FOREIGN_ACQUISITION = { entity: "S", consideration: Money.parse("80000.00", GBP) };

function acquire(): Acquisition {
  return acquisitionOf(FOREIGN_GROUP, FOREIGN_LEDGERS, FOREIGN_ACQUISITION, {
    rates: MOVING_RATES,
    presentation: GBP,
  });
}

describe("goodwill on a foreign operation is measured in the subsidiary's currency", () => {
  it("reads the net assets acquired in the subsidiary's own currency, untranslated", () => {
    const a = acquire();
    expect(a.functional.code).toBe("EUR");
    expect(a.presentation.code).toBe("GBP");
    expect(netAssets(SUB, "2025-01-01", EUR).toString()).toBe("60000.00 EUR");
    expect(a.netAssetsAcquiredIn.functional.toString()).toBe("60000.00 EUR");
  });

  it("brings the consideration into the subsidiary's currency at the acquisition rate", () => {
    // 80,000 GBP at EUR/GBP 0.80 is 100,000 EUR. The rate inverts exactly, so
    // this is not a tolerance.
    expect(acquire().considerationIn.functional.toString()).toBe("100000.00 EUR");
  });

  it("works goodwill out in euro and states it in sterling", () => {
    const a = acquire();
    expect(a.goodwillIn.functional.toString()).toBe("52000.00 EUR");
    expect(a.goodwill.toString()).toBe("41600.00 GBP");
    expect(a.nciAtAcquisitionIn.functional.toString()).toBe("12000.00 EUR");
    expect(a.nciAtAcquisition.toString()).toBe("9600.00 GBP");
  });

  it("derives every presentation figure from its functional measurement at one rate", () => {
    const a = acquire();
    const rate = MOVING_RATES.lookup(EUR, GBP, a.acquired).rate;
    const pairs = [
      a.considerationIn,
      a.netAssetsAcquiredIn,
      a.nciAtAcquisitionIn,
      a.goodwillIn,
      a.bargainGainIn,
      a.nciGoodwillIn,
    ];
    expect(pairs).toHaveLength(6);
    for (const pair of pairs) {
      expect(pair.functional.currency.code).toBe("EUR");
      expect(pair.presentation.currency.code).toBe("GBP");
      expect(pair.presentation.equals(rate.convert(pair.functional, "half-even"))).toBe(true);
    }
  });

  it("keeps the bare fields agreeing with the presentation side of each pair", () => {
    const a = acquire();
    expect(a.consideration.equals(a.considerationIn.presentation)).toBe(true);
    expect(a.netAssetsAcquired.equals(a.netAssetsAcquiredIn.presentation)).toBe(true);
    expect(a.nciAtAcquisition.equals(a.nciAtAcquisitionIn.presentation)).toBe(true);
    expect(a.goodwill.equals(a.goodwillIn.presentation)).toBe(true);
    expect(a.bargainGain.equals(a.bargainGainIn.presentation)).toBe(true);
    expect(a.nciGoodwill.equals(a.nciGoodwillIn.presentation)).toBe(true);
  });

  it("names the figure and the direction when a rate is missing", () => {
    const bare = RateTable.of([{ date: "2026-12-31", base: "EUR", quote: "GBP", rate: "0.9000" }]);
    expect(() =>
      acquisitionOf(FOREIGN_GROUP, FOREIGN_LEDGERS, FOREIGN_ACQUISITION, {
        rates: bare,
        presentation: GBP,
      }),
    ).toThrow(/consideration for S is in GBP and has to be stated in EUR/);
  });
});

describe("a group reporting in its subsidiary's currency is untouched", () => {
  const STERLING = GroupStructure.build(
    [
      { code: "P", name: "Parent Ltd", currency: GBP },
      { code: "S", name: "Sub Ltd", currency: GBP, parent: "P", holding: "80", acquired: "2025-01-01" },
    ],
    { presentation: "GBP", name: "The Group" },
  );
  const STERLING_SUB = ledgerOf(GBP_CHART, GBP, [
    { id: "S-CAP", date: "2024-12-31", narration: "Capital", debit: "1110", credit: "3100", amount: "50000.00" },
  ]);

  it("looks up no rate at all and gives both sides the same amount", () => {
    // An empty table: any lookup would throw, so passing proves none happened.
    const a = acquisitionOf(
      STERLING,
      { P: PARENT, S: STERLING_SUB },
      { entity: "S", consideration: Money.parse("48000.00", GBP) },
      { rates: RateTable.empty(), presentation: GBP },
    );
    expect(a.functional.code).toBe("GBP");
    expect(a.goodwillIn.functional.toString()).toBe("8000.00 GBP");
    expect(a.goodwillIn.presentation.toString()).toBe("8000.00 GBP");
    expect(a.goodwillIn.functional.equals(a.goodwillIn.presentation)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The rounding the measurement currency decides.
//
// Goodwill is a residual, so it has nothing to absorb a rounding error. Taking
// the residual in the presentation currency rounds three inputs and then
// subtracts them; taking it in the functional currency and translating once
// rounds one figure. The fixture below is picked so the two disagree, and the
// exact product says which of them is right.
//
//   Consideration             100,000.05 EUR
//   NCI at fair value          12,000.05 EUR
//   Net assets acquired        60,001.05 EUR
//   Rate                       0.8750
//
//   Residual in euro        =  51,999.05 EUR
//   x 0.8750 exactly        =  45,499.16875 GBP  -> 45,499.17 half-even
//
//   Each input translated:     87,500.04 + 10,500.04 - 52,500.92
//                           =  45,499.16 GBP, one minor unit low
// ---------------------------------------------------------------------------

describe("the residual is taken before the translation, not after", () => {
  const ROUNDING_RATES = RateTable.of([
    { date: "2024-12-31", base: "EUR", quote: "GBP", rate: "0.8750" },
    { date: "2025-01-01", base: "EUR", quote: "GBP", rate: "0.8750" },
  ]);
  const ODD_SUB = ledgerOf(EUR_CHART, EUR, [
    { id: "S-CAP", date: "2024-12-31", narration: "Capital", debit: "1110", credit: "3100", amount: "60001.05" },
  ]);
  const odd = (): Acquisition =>
    acquisitionOf(
      FOREIGN_GROUP,
      { P: PARENT, S: ODD_SUB },
      {
        entity: "S",
        consideration: Money.parse("100000.05", EUR),
        nciMeasurement: "fair-value",
        nciFairValue: Money.parse("12000.05", EUR),
      },
      { rates: ROUNDING_RATES, presentation: GBP },
    );

  it("takes the euro residual the three inputs imply", () => {
    const a = odd();
    expect(a.considerationIn.functional.toString()).toBe("100000.05 EUR");
    expect(a.nciAtAcquisitionIn.functional.toString()).toBe("12000.05 EUR");
    expect(a.netAssetsAcquiredIn.functional.toString()).toBe("60001.05 EUR");
    expect(a.goodwillIn.functional.toString()).toBe("51999.05 EUR");
  });

  it("states it in sterling one minor unit above what three roundings give", () => {
    const a = odd();
    const rate = ROUNDING_RATES.lookup(EUR, GBP, "2025-01-01").rate;
    const translateEach = rate
      .convert(a.considerationIn.functional, "half-even")
      .plus(rate.convert(a.nciAtAcquisitionIn.functional, "half-even"))
      .minus(rate.convert(a.netAssetsAcquiredIn.functional, "half-even"));

    expect(a.goodwill.toString()).toBe("45499.17 GBP");
    expect(translateEach.toString()).toBe("45499.16 GBP");
    expect(a.goodwill.minus(translateEach).toString()).toBe("0.01 GBP");

    // 51,999.05 x 0.8750 is 45,499.16875 exactly, so 45,499.17 is the nearer
    // of the two and the three-rounding figure is a minor unit low. The claim
    // is about which is right, not merely that they differ.
    expect(Money.parse("45499.17", GBP).minus(a.goodwill).isZero).toBe(true);
    expect(Math.abs(45499.16875 - 45499.17)).toBeLessThan(Math.abs(45499.16875 - 45499.16));
  });

  it("is a rounding, not a rate: the two agree to within one minor unit", () => {
    const a = odd();
    const rate = ROUNDING_RATES.lookup(EUR, GBP, "2025-01-01").rate;
    const translateEach = rate
      .convert(a.considerationIn.functional, "half-even")
      .plus(rate.convert(a.nciAtAcquisitionIn.functional, "half-even"))
      .minus(rate.convert(a.netAssetsAcquiredIn.functional, "half-even"));
    expect(a.goodwill.within(translateEach, Money.parse("0.01", GBP))).toBe(true);
    expect(a.goodwill.equals(translateEach)).toBe(false);
  });
});

describe("fair value for the outside stake is a euro figure too", () => {
  it("attributes the excess over its share of net assets in the functional currency", () => {
    const a = acquisitionOf(
      FOREIGN_GROUP,
      FOREIGN_LEDGERS,
      {
        entity: "S",
        consideration: Money.parse("80000.00", GBP),
        nciMeasurement: "fair-value",
        nciFairValue: Money.parse("15000.00", EUR),
      },
      { rates: MOVING_RATES, presentation: GBP },
    );
    // 20% of 60,000 EUR is 12,000; the stake was worth 15,000, so 3,000 EUR of
    // the goodwill is the outside shareholders'.
    expect(a.nciAtAcquisitionIn.functional.toString()).toBe("15000.00 EUR");
    expect(a.nciGoodwillIn.functional.toString()).toBe("3000.00 EUR");
    expect(a.nciGoodwill.toString()).toBe("2400.00 GBP");
    // And the whole goodwill is 3,000 EUR larger than under the proportionate
    // method, which is exactly the stake's share of it.
    expect(a.goodwillIn.functional.toString()).toBe("55000.00 EUR");
    expect(a.goodwillIn.functional.minus(acquire().goodwillIn.functional).toString()).toBe(
      "3000.00 EUR",
    );
  });

  it("refuses a fair value in a currency it cannot reach", () => {
    expect(() =>
      acquisitionOf(
        FOREIGN_GROUP,
        FOREIGN_LEDGERS,
        {
          entity: "S",
          consideration: Money.parse("100000.00", EUR),
          nciMeasurement: "fair-value",
          nciFairValue: Money.parse("20000.00", Money.parse("1.00", "JPY").currency),
        },
        { rates: MOVING_RATES, presentation: GBP },
      ),
    ).toThrow(GroupError);
  });
});
