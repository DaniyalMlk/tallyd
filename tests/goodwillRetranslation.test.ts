import { describe, expect, it } from "vitest";
import { dateRange, date } from "../src/ledger/date.js";
import { EUR, GBP } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { RateTable } from "../src/fx/table.js";
import { GroupStructure } from "../src/group/structure.js";
import {
  type AcquisitionInput,
  acquisitionOf,
  goodwillAt,
} from "../src/group/acquisition.js";
import { type Consolidation, consolidate } from "../src/group/consolidate.js";
import { nciSchedule, translationReserveSchedule } from "../src/group/movement.js";
import {
  FOREIGN_ACQUISITION,
  FOREIGN_GROUP,
  FOREIGN_LEDGERS,
  FOREIGN_PARENT,
  GBP_CHART,
  MOVING_RATES,
  ledgerOf,
} from "./foreignGroup.js";

const FAIR_VALUE: AcquisitionInput = {
  entity: "S",
  consideration: Money.parse("80000.00", GBP),
  nciMeasurement: "fair-value",
  nciFairValue: Money.parse("15000.00", EUR),
};

function at(end: string, acquisition: AcquisitionInput = FOREIGN_ACQUISITION): Consolidation {
  const start = `${Number(end.slice(0, 4))}-01-01`;
  return consolidate(FOREIGN_GROUP, FOREIGN_LEDGERS, {
    asAt: end,
    period: dateRange(start, end),
    rates: MOVING_RATES,
    acquisitions: [acquisition],
  });
}

describe("goodwill on a foreign operation is carried at the closing rate", () => {
  it("is the acquisition figure on a date whose rate has not moved", () => {
    // EUR/GBP is still 0.80 at the first reporting date, so nothing should
    // move. A test that only looked at the second date could not tell the
    // closing rate from a constant.
    const first = at("2025-12-31").workings[0]!.goodwillCarrying;
    expect(first.functional.toString()).toBe("52000.00 EUR");
    expect(first.carrying.toString()).toBe("41600.00 GBP");
    expect(first.exchangeDifference.isZero).toBe(true);
  });

  it("moves with the rate at the next one, and the measurement does not", () => {
    const second = at("2026-12-31").workings[0]!.goodwillCarrying;
    // 52,000 EUR at 0.90 rather than at the 0.80 of the day it was bought.
    expect(second.functional.toString()).toBe("52000.00 EUR");
    expect(second.carrying.toString()).toBe("46800.00 GBP");
    expect(second.atAcquisition.toString()).toBe("41600.00 GBP");
    expect(second.exchangeDifference.toString()).toBe("5200.00 GBP");
    // 11.1% of the carrying amount, and in the direction that looks stable
    // rather than wrong, which is why holding it at the old rate was invisible.
    expect(
      Number(second.exchangeDifference.toDecimalString()) /
        Number(second.carrying.toDecimalString()),
    ).toBeCloseTo(0.1111, 4);
  });

  it("reaches the goodwill account itself, not only the workings", () => {
    expect(at("2025-12-31").goodwill.toString()).toBe("41600.00 GBP");
    expect(at("2026-12-31").goodwill.toString()).toBe("46800.00 GBP");
  });

  it("puts the exchange difference in the translation reserve", () => {
    const second = at("2026-12-31");
    const adjustment = second.aggregation.translationAdjustment;
    // The reserve is the entity's own translation adjustment plus goodwill's
    // exchange difference, and those two are all of it.
    expect(adjustment.toString()).toBe("-8562.74 GBP");
    expect(second.translationReserve.toString()).toBe("13762.74 GBP");
    expect(
      second.translationReserve
        .plus(adjustment)
        .minus(second.workings[0]!.goodwillCarrying.groupExchangeDifference)
        .isZero,
    ).toBe(true);
  });

  it("contributes nothing to the entry it sits in, so the balancing figure cannot move", () => {
    // The balancing figure of the elimination entry is the group's share of
    // post-acquisition reserves, and retranslating goodwill must not touch it.
    // What guarantees that is arithmetic rather than a second computation: the
    // entry puts goodwill on at the closing rate and credits the difference
    // away, so the postings the retranslation added sum to nothing.
    //
    //   carrying - the group's share - the stake's share = the acquisition
    //   figure
    //
    // The stake's share is not a posting of its own — it is already inside the
    // claim measured at this date — so the three figures below are where the
    // whole difference went.
    const c = at("2026-12-31", FAIR_VALUE);
    const working = c.workings[0]!;
    const carrying = working.goodwillCarrying;
    expect(
      carrying.carrying
        .minus(carrying.groupExchangeDifference)
        .minus(carrying.nciExchangeDifference)
        .equals(carrying.atAcquisition),
    ).toBe(true);

    // And the reserve posting is really in the entry, under a memo that says
    // what it is, rather than the difference having been absorbed somewhere.
    const entry = c.ledger.entry("CONS-S");
    const reserve = entry?.postings.filter((p) => p.account === "3250") ?? [];
    expect(reserve).toHaveLength(1);
    expect(reserve[0]?.amount.toString()).toBe("-5200.00 GBP");
    expect(reserve[0]?.memo).toContain("retranslated from EUR");
    // Nothing of the difference went to the outside stake twice: the entry has
    // one posting to it, not two.
    expect(entry?.postings.filter((p) => p.account === "3400")).toHaveLength(1);
  });

  it("balances the books and leaves nothing in the investment account", () => {
    for (const end of ["2025-12-31", "2026-12-31"]) {
      const c = at(end);
      expect(c.balanced, end).toBe(true);
      expect(c.residual.isZero, end).toBe(true);
      expect(c.investmentResidual.isZero, end).toBe(true);
    }
  });

  it("names goodwill when the closing rate it needs is missing", () => {
    const acquisitionOnly = RateTable.of(
      [
        { date: "2024-12-31", base: "EUR", quote: "GBP", rate: "0.8000" },
        { date: "2025-01-01", base: "EUR", quote: "GBP", rate: "0.8000" },
      ],
      { maxStaleDays: 1 },
    );
    const acquisition = acquisitionOf(FOREIGN_GROUP, FOREIGN_LEDGERS, FOREIGN_ACQUISITION, {
      rates: acquisitionOnly,
      presentation: GBP,
    });
    expect(() => goodwillAt(acquisition, { rates: acquisitionOnly }, date("2026-12-31"))).toThrow(
      /Goodwill on S is EUR and has to be carried at the GBP closing rate/,
    );
  });
});

describe("how the exchange difference is split with the outside stake", () => {
  it("gives the stake none of it when the stake owns no goodwill", () => {
    // 20% of the company and 0% of the goodwill: under the proportionate
    // method the stake is a share of identifiable net assets and nothing else.
    // The split is about the measurement, not the size of the holding.
    const carrying = at("2026-12-31").workings[0]!.goodwillCarrying;
    expect(FOREIGN_GROUP.get("S").nonControlling.toPercentString(0)).toBe("20%");
    expect(carrying.nciFunctional.isZero).toBe(true);
    expect(carrying.nciExchangeDifference.isZero).toBe(true);
    expect(carrying.groupExchangeDifference.equals(carrying.exchangeDifference)).toBe(true);
  });

  it("gives it the difference on its own slice when it was measured at fair value", () => {
    const carrying = at("2026-12-31", FAIR_VALUE).workings[0]!.goodwillCarrying;
    // 3,000 EUR of goodwill is the stake's; the rate moved 0.10, so 300 of the
    // 5,500 difference is the stake's and the other 5,200 is the group's.
    expect(carrying.nciFunctional.toString()).toBe("3000.00 EUR");
    expect(carrying.exchangeDifference.toString()).toBe("5500.00 GBP");
    expect(carrying.nciExchangeDifference.toString()).toBe("300.00 GBP");
    expect(carrying.groupExchangeDifference.toString()).toBe("5200.00 GBP");
    expect(
      carrying.groupExchangeDifference
        .plus(carrying.nciExchangeDifference)
        .equals(carrying.exchangeDifference),
    ).toBe(true);
  });

  it("carries the stake's goodwill at the closing rate in its claim", () => {
    const first = at("2025-12-31", FAIR_VALUE);
    const second = at("2026-12-31", FAIR_VALUE);
    // 15,200 = 20% of 80,000 EUR of net assets at 0.80, plus 3,000 at 0.80.
    expect(first.nonControllingInterest.toString()).toBe("15200.00 GBP");
    // 18,900 = 20% of 90,000 EUR at 0.90, plus 3,000 at 0.90.
    expect(second.nonControllingInterest.toString()).toBe("18900.00 GBP");
  });

  it("does not count the stake's share twice", () => {
    // Posting the stake's exchange difference as well as measuring its claim
    // at the closing rate credits it 300 too much. The claim is measured
    // directly at the reporting date, so it already contains the difference.
    const second = at("2026-12-31", FAIR_VALUE);
    const working = second.workings[0]!;
    expect(second.nonControllingInterest.equals(working.nciClosing)).toBe(true);
    const netAssetsShare = FOREIGN_GROUP.get("S")
      .nonControlling.share(working.netAssetsNow, "half-even");
    expect(
      working.nciClosing.equals(netAssetsShare.plus(working.goodwillCarrying.nciCarrying)),
    ).toBe(true);
  });
});

describe("the schedules explain it rather than leaving it unexplained", () => {
  const prior = at("2025-12-31", FAIR_VALUE);
  const current = at("2026-12-31", FAIR_VALUE);

  it("gives the translation reserve a line for goodwill and reconciles", () => {
    const schedule = translationReserveSchedule(prior, current);
    expect(schedule.lines.map((l) => l.label)).toEqual([
      "S — movement on retranslation",
      "S — goodwill retranslated",
    ]);
    expect(schedule.lines[1]?.amount.toString()).toBe("5200.00 GBP");
    expect(schedule.unexplained.isZero).toBe(true);
    expect(schedule.reconciles).toBe(true);
  });

  it("gives the outside stake a line for its own goodwill and reconciles", () => {
    const schedule = nciSchedule(prior, current, { rates: MOVING_RATES });
    const line = schedule.lines.find((l) => l.label === "Its own goodwill, retranslated");
    expect(line?.amount.toString()).toBe("300.00 GBP");
    expect(schedule.unexplained.isZero).toBe(true);
    expect(schedule.reconciles).toBe(true);
  });

  it("reconciles in the period of acquisition too", () => {
    // Nothing was there to move, so the whole opening claim arises — and it
    // has to arise at the rate the consolidation carried it at, which for the
    // stake's goodwill is the closing rate and not the acquisition rate. Here
    // the two coincide, so the case that matters is the reserve's.
    const opening = at("2025-12-31", FAIR_VALUE);
    const nothing = at("2025-12-31", FAIR_VALUE);
    const schedule = nciSchedule(nothing, opening, { rates: MOVING_RATES });
    expect(schedule.unexplained.isZero).toBe(true);
  });
});

describe("a foreign subsidiary sold part-way through the year", () => {
  // The same company and the same books, with control lost on 2026-09-30 when
  // EUR/GBP was 0.87. Goodwill has to come off at what the group was carrying
  // it at that day — 52,000 EUR at 0.87, not the 0.80 of the day it was
  // bought — or the gain is measured against a figure the balance sheet never
  // showed and the difference is left in the goodwill account with no company
  // attached to it.
  const SOLD = GroupStructure.build(
    [
      { code: "P", name: "Parent Ltd", currency: GBP },
      {
        code: "S",
        name: "Sub GmbH",
        currency: EUR,
        parent: "P",
        holding: "80",
        acquired: "2025-01-01",
        disposed: "2026-09-30",
      },
    ],
    { presentation: "GBP", name: "Cross-border Group" },
  );

  // The fair-value measurement on purpose: it gives the outside stake goodwill
  // of its own, so a claim taken at the acquisition rate instead of the
  // disposal-date rate is a different number. Under the proportionate method
  // the stake owns no goodwill and the two rates give the same answer, which
  // would make the test below pass whatever the code did.
  const sold = (proceeds: string): Consolidation =>
    consolidate(SOLD, FOREIGN_LEDGERS, {
      asAt: "2026-12-31",
      period: dateRange("2026-01-01", "2026-12-31"),
      rates: MOVING_RATES,
      acquisitions: [FAIR_VALUE],
      disposals: [{ entity: "S", proceeds: Money.parse(proceeds, GBP) }],
    });

  it("derecognises goodwill at the rate on the day control was lost", () => {
    const disposal = sold("120000.00").disposals[0]!.disposal;
    // 55,000 EUR at 0.87, where the acquisition rate was 0.80.
    expect(disposal.goodwillCarrying.functional.toString()).toBe("55000.00 EUR");
    expect(disposal.goodwillCarrying.rate?.toString()).toContain("0.87");
    expect(disposal.goodwillDerecognised.toString()).toBe("47850.00 GBP");
    expect(disposal.goodwillCarrying.atAcquisition.toString()).toBe("44000.00 GBP");
    expect(disposal.goodwillCarrying.exchangeDifference.toString()).toBe("3850.00 GBP");
  });

  it("measures the gain against that figure and not the acquisition one", () => {
    const disposal = sold("120000.00").disposals[0]!.disposal;
    const rebuilt = disposal.netAssetsAtDisposal
      .minus(disposal.nciAtDisposal)
      .plus(disposal.goodwillDerecognised);
    expect(disposal.carryingAmount.equals(rebuilt)).toBe(true);
    // Carrying 3,640 more than the acquisition-date figure would give means a
    // gain 3,640 smaller, which is the whole point: the group did not make
    // money on a currency move it had already put through reserves.
    expect(
      disposal.gain
        .plus(disposal.goodwillCarrying.exchangeDifference)
        .equals(
          disposal.proceeds
            .minus(disposal.netAssetsAtDisposal.minus(disposal.nciAtDisposal))
            .minus(disposal.goodwillCarrying.atAcquisition),
        ),
    ).toBe(true);
  });

  it("empties the goodwill account rather than leaving the difference behind", () => {
    // The symptom of taking off the acquisition figure: a balance left in an
    // asset account for a company that is no longer in the group.
    const c = sold("120000.00");
    expect(c.goodwill.isZero).toBe(true);
    expect(c.balanced).toBe(true);
    expect(c.residual.isZero).toBe(true);
  });

  it("removes the stake's claim at the same date's rate", () => {
    const disposal = sold("120000.00").disposals[0]!.disposal;
    const share = SOLD.get("S").nonControlling;
    const carrying = disposal.goodwillCarrying;
    // 3,000 EUR of the goodwill is the stake's, so the two rates genuinely
    // differ here and the assertion below is not satisfied by both.
    expect(carrying.nciCarrying.toString()).toBe("2610.00 GBP");
    expect(carrying.nciAtAcquisition.toString()).toBe("2400.00 GBP");
    expect(
      disposal.nciAtDisposal.equals(
        share.share(disposal.netAssetsAtDisposal, "half-even").plus(carrying.nciCarrying),
      ),
    ).toBe(true);
    expect(
      disposal.nciAtDisposal.equals(
        share.share(disposal.netAssetsAtDisposal, "half-even").plus(carrying.nciAtAcquisition),
      ),
    ).toBe(false);
  });
});

describe("a group that keeps its books in the presentation currency", () => {
  const STERLING = GroupStructure.build(
    [
      { code: "P", name: "Parent Ltd", currency: GBP },
      { code: "S", name: "Sub Ltd", currency: GBP, parent: "P", holding: "80", acquired: "2025-01-01" },
    ],
    { presentation: "GBP", name: "The Group" },
  );
  const SUB = ledgerOf(GBP_CHART, GBP, [
    { id: "S-CAP", date: "2024-12-31", narration: "Capital", debit: "1110", credit: "3100", amount: "50000.00" },
    { id: "S-INC", date: "2026-06-30", narration: "Sales", debit: "1110", credit: "4100", amount: "30000.00" },
    { id: "S-EXP", date: "2026-06-30", narration: "Cost of sales", debit: "5100", credit: "1110", amount: "25000.00" },
  ]);

  it("has no exchange difference and looks up no closing rate", () => {
    const c = consolidate(
      STERLING,
      { P: FOREIGN_PARENT, S: SUB },
      {
        asAt: "2026-12-31",
        period: dateRange("2026-01-01", "2026-12-31"),
        // Empty: a lookup happening at all would throw.
        rates: RateTable.empty(),
        acquisitions: [{ entity: "S", consideration: Money.parse("48000.00", GBP) }],
      },
    );
    const carrying = c.workings[0]!.goodwillCarrying;
    expect(carrying.rate).toBeNull();
    expect(carrying.exchangeDifference.isZero).toBe(true);
    expect(carrying.carrying.equals(carrying.atAcquisition)).toBe(true);
    expect(c.goodwill.toString()).toBe("8000.00 GBP");
    expect(c.translationReserve.isZero).toBe(true);
  });

});
