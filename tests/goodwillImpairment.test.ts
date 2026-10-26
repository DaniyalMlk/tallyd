import { describe, expect, it } from "vitest";
import { dateRange, date } from "../src/ledger/date.js";
import { EUR, GBP } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { RateTable } from "../src/fx/table.js";
import { GroupError, GroupStructure } from "../src/group/structure.js";
import {
  type AcquisitionInput,
  type GoodwillImpairment,
  acquisitionOf,
  goodwillAt,
} from "../src/group/acquisition.js";
import { type Consolidation, consolidate, renderConsolidation } from "../src/group/consolidate.js";
import { nciSchedule, translationReserveSchedule } from "../src/group/movement.js";
import {
  EUR_CHART,
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

/** 4,000 EUR written off at the end of 2025 and 6,000 more in mid-2026. */
const HISTORY: readonly GoodwillImpairment[] = [
  { entity: "S", amount: Money.parse("4000.00", EUR), on: "2025-12-31" },
  { entity: "S", amount: Money.parse("6000.00", EUR), on: "2026-06-30" },
];

function at(
  end: string,
  acquisition: AcquisitionInput = FAIR_VALUE,
  impairments: readonly GoodwillImpairment[] = HISTORY,
): Consolidation {
  return consolidate(FOREIGN_GROUP, FOREIGN_LEDGERS, {
    asAt: end,
    period: dateRange(`${Number(end.slice(0, 4))}-01-01`, end),
    rates: MOVING_RATES,
    acquisitions: [acquisition],
    goodwillImpairments: impairments,
  });
}

const balance = (c: Consolidation, account: string): string =>
  c.ledger.balanceOf(account, "GBP").toDecimalString();

describe("goodwill written off reduces the measurement, not the translation", () => {
  it("takes the write-off in the subsidiary's currency before any rate", () => {
    const carrying = at("2026-12-31").workings[0]!.goodwillCarrying;
    expect(carrying.grossFunctional.toString()).toBe("55000.00 EUR");
    expect(carrying.impairedFunctional.toString()).toBe("10000.00 EUR");
    expect(carrying.functional.toString()).toBe("45000.00 EUR");
    // 45,000 EUR at the 0.90 closing rate.
    expect(carrying.carrying.toString()).toBe("40500.00 GBP");
    expect(balance(at("2026-12-31"), "1290")).toBe("40500.00");
  });

  it("charges each write-off at the rate on the day it was recognised", () => {
    const carrying = at("2026-12-31").workings[0]!.goodwillCarrying;
    // 4,000 at 0.80 is 3,200; 6,000 at the 30 June rate of 0.85 is 5,100.
    expect(carrying.recognisedToDate.toString()).toBe("8300.00 GBP");
    expect(carrying.impairmentLoss.toString()).toBe("5100.00 GBP");
    expect(balance(at("2026-12-31"), "5975")).toBe("5100.00");
  });

  it("charges only this period's events, not the history", () => {
    // The declaration is a list of events precisely so that a later reporting
    // date can tell the two apart. A cumulative total could not, and the 2026
    // column would carry 8,300.00 of expense for a year in which 5,100.00 was
    // written off.
    expect(balance(at("2025-12-31"), "5975")).toBe("3200.00");
    expect(balance(at("2026-12-31"), "5975")).toBe("5100.00");
    const first = at("2025-12-31").workings[0]!.goodwillCarrying;
    expect(first.impairedFunctional.toString()).toBe("4000.00 EUR");
    expect(first.chargedFunctional.toString()).toBe("4000.00 EUR");
    const second = at("2026-12-31").workings[0]!.goodwillCarrying;
    expect(second.impairedFunctional.toString()).toBe("10000.00 EUR");
    expect(second.chargedFunctional.toString()).toBe("6000.00 EUR");
  });

  it("ignores a write-off dated after the date being reported", () => {
    const later: readonly GoodwillImpairment[] = [
      ...HISTORY,
      { entity: "S", amount: Money.parse("1000.00", EUR), on: "2027-06-30" },
    ];
    expect(at("2026-12-31", FAIR_VALUE, later).goodwill.toString()).toBe(
      at("2026-12-31").goodwill.toString(),
    );
  });
});

describe("the exchange difference and the write-off are kept apart", () => {
  it("leaves the difference alone where the write-off took the closing rate", () => {
    // 55,000 EUR, bought at 0.80 and reported at 0.90, gives 5,500 of exchange
    // difference. Writing 10,000 off *at the closing rate* makes the asset
    // smaller and the figure it is measured against smaller by the same
    // amount, so the difference is unchanged. Anything else would mean one of
    // the two effects had leaked into the other.
    const atClosing: readonly GoodwillImpairment[] = [
      { entity: "S", amount: Money.parse("10000.00", EUR), on: "2026-12-31" },
    ];
    const none = at("2026-12-31", FAIR_VALUE, []);
    const written = at("2026-12-31", FAIR_VALUE, atClosing);
    expect(none.workings[0]!.goodwillCarrying.exchangeDifference.toString()).toBe("5500.00 GBP");
    expect(written.workings[0]!.goodwillCarrying.exchangeDifference.toString()).toBe("5500.00 GBP");
    expect(none.translationReserve.equals(written.translationReserve)).toBe(true);
  });

  it("reduces it by the rate the write-off actually took, where that differs", () => {
    // The history above writes off at 0.80 and 0.85 against a 0.90 close, so
    // 4,000 x 0.10 and 6,000 x 0.05 of the difference have already gone
    // through the income statement: 5,500 - 400 - 300 = 4,800.
    const carrying = at("2026-12-31").workings[0]!.goodwillCarrying;
    expect(carrying.exchangeDifference.toString()).toBe("4800.00 GBP");
    const byHand = 5500 - 4000 * (0.9 - 0.8) - 6000 * (0.9 - 0.85);
    expect(Number(carrying.exchangeDifference.toDecimalString())).toBeCloseTo(byHand, 2);
  });

  it("adds up: the asset's whole movement is the charge plus the difference", () => {
    const carrying = at("2026-12-31").workings[0]!.goodwillCarrying;
    const recognised = carrying.atAcquisition.plus(carrying.recognisedToDate);
    expect(recognised.toString()).toBe("44000.00 GBP");
    expect(
      recognised
        .minus(carrying.recognisedToDate)
        .plus(carrying.exchangeDifference)
        .equals(carrying.carrying),
    ).toBe(true);
  });
});

describe("whose loss it is, and why the basis is not the retranslation's", () => {
  it("shares the charge by the ownership fraction", () => {
    const carrying = at("2026-12-31").workings[0]!.goodwillCarrying;
    // 20% of this period's 5,100 charge.
    expect(carrying.nciImpairmentLoss.toString()).toBe("1020.00 GBP");
    expect(carrying.groupImpairmentLoss.toString()).toBe("4080.00 GBP");
    expect(
      carrying.groupImpairmentLoss.plus(carrying.nciImpairmentLoss).equals(carrying.impairmentLoss),
    ).toBe(true);
  });

  it("shares the exchange difference by the goodwill, which is a different answer", () => {
    // This is the pair worth reading together. The stake owns 20% of the
    // company and 3,000 of the 55,000 of goodwill, which is 5.45%. Its share
    // of the charge is the first of those; its share of the exchange
    // difference is the second. Using one basis for both is plausible, and
    // wrong whichever way round it is done.
    const untouched = at("2026-12-31", FAIR_VALUE, []).workings[0]!.goodwillCarrying;
    const ofDifference =
      Number(untouched.nciExchangeDifference.toDecimalString()) /
      Number(untouched.exchangeDifference.toDecimalString());
    expect(ofDifference).toBeCloseTo(3000 / 55000, 6);

    const carrying = at("2026-12-31").workings[0]!.goodwillCarrying;
    const ofCharge =
      Number(carrying.nciImpairmentLoss.toDecimalString()) /
      Number(carrying.impairmentLoss.toDecimalString());
    expect(ofCharge).toBeCloseTo(0.2, 6);

    // Not the same number, and not nearly: the ownership basis gives the stake
    // nearly four times as much of a loss as the goodwill basis would.
    expect(ofCharge / ofDifference).toBeCloseTo(55000 / 3000 / 5, 3);
    expect(ofDifference).toBeLessThan(ofCharge);
  });

  it("gives the stake no share of the charge when it owns no goodwill", () => {
    // Proportionate measurement: the balance sheet carries only the group's
    // own goodwill, so the only write-down that can be recognised against it
    // is the group's. The stake still holds 20% of the company.
    const carrying = at("2026-12-31", FOREIGN_ACQUISITION).workings[0]!.goodwillCarrying;
    expect(FOREIGN_GROUP.get("S").nonControlling.toPercentString(0)).toBe("20%");
    expect(carrying.impairmentLoss.toString()).toBe("5100.00 GBP");
    expect(carrying.nciImpairmentLoss.isZero).toBe(true);
    expect(carrying.groupImpairmentLoss.equals(carrying.impairmentLoss)).toBe(true);
  });
});

describe("where the stake's share of the charge goes", () => {
  it("comes out of the result, not out of reserves brought forward", () => {
    const c = at("2026-12-31");
    const working = c.workings[0]!;
    // Its share of the subsidiary's own result is 1,687.45; its share of this
    // period's write-off is 1,020.00; what is allocated to it is the
    // difference. The write-off is a group-level charge the subsidiary's books
    // have never heard of, so it cannot come out of the first figure.
    expect(working.nciProfitShare.toString()).toBe("1687.45 GBP");
    expect(working.nciResultShare.toString()).toBe("667.45 GBP");
    expect(balance(c, "3410")).toBe("667.45");
  });

  it("leaves the group's post-acquisition reserves alone when the loss is this period's", () => {
    // The invariant: a write-off recognised in this period is this period's
    // loss and belongs in this period's result. If the stake's share fell into
    // the balancing figure instead it would read as reserves the group earned.
    const none = at("2026-12-31", FAIR_VALUE, []);
    const thisPeriod = at("2026-12-31", FAIR_VALUE, [HISTORY[1]!]);
    expect(balance(none, "3200")).toBe("-11087.45");
    expect(balance(thisPeriod, "3200")).toBe("-11087.45");
    expect(
      none.workings[0]!.postAcquisitionReserves.equals(
        thisPeriod.workings[0]!.postAcquisitionReserves,
      ),
    ).toBe(true);
  });

  it("but takes the group's share of an earlier loss out of reserves brought forward", () => {
    // Which is the other half of the same statement rather than an exception
    // to it: a loss recognised in 2025 is in the reserves 2026 opens with, so
    // it has to reduce them. The first version of the test above asserted the
    // reserves were untouched by *any* write-off and failed on exactly this,
    // which was the test being wrong rather than the engine.
    //
    // 4,000 EUR written off at 0.80 is 3,200; the stake bore 640 of it in that
    // year's result, so the group's 2,560 is what comes out of the brought
    // forward figure.
    const both = at("2026-12-31");
    expect(balance(both, "3200")).toBe("-8527.45");
    expect(Number(balance(both, "3200")) - -11087.45).toBeCloseTo(2560, 2);
  });

  it("takes the stake's claim down by its share of everything written off", () => {
    const c = at("2026-12-31");
    const carrying = c.workings[0]!.goodwillCarrying;
    // 3,000 EUR of goodwill less 20% of the 10,000 written off is 1,000 EUR,
    // at 0.90.
    expect(carrying.nciFunctional.toString()).toBe("1000.00 EUR");
    expect(carrying.nciCarrying.toString()).toBe("900.00 GBP");
    expect(balance(c, "3400")).toBe("-17100.00");
  });

  it("balances, and leaves nothing in the investment account", () => {
    for (const end of ["2025-12-31", "2026-12-31"]) {
      const c = at(end);
      expect(c.balanced, end).toBe(true);
      expect(c.residual.isZero, end).toBe(true);
      expect(c.investmentResidual.isZero, end).toBe(true);
    }
  });
});

describe("the schedules still reconcile with a write-off in the period", () => {
  it("rolls the outside stake forward exactly", () => {
    const schedule = nciSchedule(at("2025-12-31"), at("2026-12-31"), { rates: MOVING_RATES });
    expect(schedule.unexplained.isZero).toBe(true);
    expect(schedule.reconciles).toBe(true);
  });

  it("rolls the translation reserve forward exactly", () => {
    const schedule = translationReserveSchedule(at("2025-12-31"), at("2026-12-31"));
    expect(schedule.unexplained.isZero).toBe(true);
    expect(schedule.reconciles).toBe(true);
  });
});

describe("the workings say what happened", () => {
  it("prints a column a reader can add down", () => {
    const text = renderConsolidation(at("2026-12-31"));
    expect(text).toContain("Goodwill at cost");
    expect(text).toContain("written off to date (5100.00 this period)");
    expect(text).toContain("retranslated at the closing rate");
    expect(text).toContain("less its share of the goodwill written off");

    // 44,000.00 - 8,300.00 + 4,800.00 = 40,500.00, down the column.
    const figure = (label: RegExp): number => {
      const line = text.split("\n").find((l) => label.test(l.trim()));
      expect(line, String(label)).toBeDefined();
      return Number((line as string).trim().split(/\s{2,}/).pop());
    };
    // The plain Goodwill line is matched to the end of its label, because
    // "Goodwill at cost" also begins with it — a looser match made the first
    // version of this test compare the cost figure with itself.
    expect(
      figure(/^Goodwill at cost\s/) +
        figure(/^written off to date\s*\(/) +
        figure(/^retranslated at the closing rate\s/),
    ).toBeCloseTo(figure(/^Goodwill\s{2,}-?[\d.]+$/), 2);
  });

  it("says nothing about impairment where nothing was written off", () => {
    const text = renderConsolidation(at("2026-12-31", FAIR_VALUE, []));
    expect(text).not.toContain("written off");
    expect(text).not.toContain("Goodwill at cost");
    expect(text).toContain("Goodwill");
  });
});

describe("what it refuses", () => {
  const acquisition = () =>
    acquisitionOf(FOREIGN_GROUP, FOREIGN_LEDGERS, FAIR_VALUE, {
      rates: MOVING_RATES,
      presentation: GBP,
    });

  it("refuses to write off more goodwill than there is", () => {
    expect(() =>
      goodwillAt(
        acquisition(),
        {
          rates: MOVING_RATES,
          impairments: [{ entity: "S", amount: Money.parse("60000.00", EUR), on: "2026-12-31" }],
        },
        date("2026-12-31"),
      ),
    ).toThrow(/only has 55000.00 EUR/);
  });

  it("refuses to write goodwill back up", () => {
    expect(() =>
      goodwillAt(
        acquisition(),
        {
          rates: MOVING_RATES,
          impairments: [{ entity: "S", amount: Money.parse("-1000.00", EUR), on: "2026-12-31" }],
        },
        date("2026-12-31"),
      ),
    ).toThrow(/stays recognised/);
  });

  it("refuses a write-off dated before the goodwill arose", () => {
    expect(() =>
      goodwillAt(
        acquisition(),
        {
          rates: MOVING_RATES,
          impairments: [{ entity: "S", amount: Money.parse("1000.00", EUR), on: "2024-12-31" }],
        },
        date("2026-12-31"),
      ),
    ).toThrow(/before it arose on 2025-01-01/);
  });

  it("refuses a write-off meant for another company", () => {
    expect(() =>
      goodwillAt(
        acquisition(),
        {
          rates: MOVING_RATES,
          impairments: [{ entity: "T", amount: Money.parse("1000.00", EUR), on: "2026-12-31" }],
        },
        date("2026-12-31"),
      ),
    ).toThrow(GroupError);
  });

  it("refuses to write the outside stake's claim below what it was given", () => {
    // 20% of 20,000 is 4,000, and only 3,000 of goodwill was ever attributed
    // to the stake. Charging it for the other 1,000 would be charging it for
    // goodwill it never had — a real case rather than a hypothetical, since
    // the standard's gross-up of a partly-recognised loss is not modelled
    // here and guessing at it would be worse than refusing.
    expect(() =>
      goodwillAt(
        acquisition(),
        {
          rates: MOVING_RATES,
          impairments: [{ entity: "S", amount: Money.parse("20000.00", EUR), on: "2026-12-31" }],
        },
        date("2026-12-31"),
      ),
    ).toThrow(/goodwill it never had/);
  });
});

describe("a sterling group writes off sterling", () => {
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

  it("needs no rate at all and has no exchange difference", () => {
    const c = consolidate(
      STERLING,
      { P: FOREIGN_PARENT, S: SUB },
      {
        asAt: "2026-12-31",
        period: dateRange("2026-01-01", "2026-12-31"),
        rates: RateTable.empty(),
        acquisitions: [{ entity: "S", consideration: Money.parse("48000.00", GBP) }],
        goodwillImpairments: [
          { entity: "S", amount: Money.parse("2000.00", GBP), on: "2026-09-30" },
        ],
      },
    );
    const carrying = c.workings[0]!.goodwillCarrying;
    expect(carrying.rate).toBeNull();
    expect(carrying.grossFunctional.toString()).toBe("8000.00 GBP");
    expect(carrying.carrying.toString()).toBe("6000.00 GBP");
    expect(carrying.impairmentLoss.toString()).toBe("2000.00 GBP");
    expect(carrying.exchangeDifference.isZero).toBe(true);
    expect(balance(c, "5975")).toBe("2000.00");
    expect(c.balanced).toBe(true);
  });
});

// The euro chart is imported so the fixture module's own exports stay
// referenced from here as well as from its other users.
void EUR_CHART;
