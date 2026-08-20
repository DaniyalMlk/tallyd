import { describe, expect, it } from "vitest";
import { EUR, GBP, USD } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { JournalEntry } from "../src/ledger/entry.js";
import { Ledger } from "../src/ledger/ledger.js";
import { dateRange } from "../src/ledger/date.js";
import { RateTable } from "../src/fx/table.js";
import { groupChart } from "../src/group/accounts.js";
import { GroupStructure } from "../src/group/structure.js";
import { consolidate } from "../src/group/consolidate.js";
import type { Consolidation } from "../src/group/consolidate.js";
import {
  nciMovements,
  nciSchedule,
  netAssetsMovement,
  netAssetsMovements,
  renderMovementSchedule,
  renderNetAssetsMovements,
  translationReserveSchedule,
} from "../src/group/movement.js";
import * as demo from "../src/demo/group.js";

const shared = () => ({
  rates: demo.groupRates(),
  intercompany: demo.groupIntercompany(),
  acquisitions: demo.groupAcquisitions(),
});

function priorAndCurrent(): { prior: Consolidation; current: Consolidation } {
  const group = demo.groupStructure();
  const ledgers = demo.groupLedgers();
  const base = shared();
  return {
    prior: consolidate(group, ledgers, {
      ...base,
      asAt: demo.GROUP_PRIOR_AS_AT,
      period: demo.groupPriorPeriod(),
    }),
    current: consolidate(group, ledgers, {
      ...base,
      asAt: demo.GROUP_AS_AT,
      period: demo.groupPeriod(),
    }),
  };
}

describe("the identity the decomposition rests on", () => {
  const { prior, current } = priorAndCurrent();
  const rates = demo.groupRates();
  const movements = netAssetsMovements(prior, current, { rates });

  it("covers every subsidiary the consolidation worked on", () => {
    expect(movements.map((m) => m.entity)).toEqual(current.workings.map((w) => w.entity));
    expect(movements.length).toBe(2);
  });

  it("opening plus the three components is closing, exactly, for every entity", () => {
    for (const movement of movements) {
      const rolled = movement.opening
        .plus(movement.translationEffect)
        .plus(movement.result)
        .plus(movement.other);
      expect(rolled.toDecimalString()).toBe(movement.closing.toDecimalString());
    }
  });

  it("takes its opening and closing figures from the two consolidations themselves", () => {
    for (const movement of movements) {
      const before = prior.workings.find((w) => w.entity === movement.entity);
      const now = current.workings.find((w) => w.entity === movement.entity);
      expect(movement.opening.equals(before?.netAssetsNow as Money)).toBe(true);
      expect(movement.closing.equals(now?.netAssetsNow as Money)).toBe(true);
      expect(movement.result.equals(now?.profitForPeriod as Money)).toBe(true);
    }
  });

  it("dates each movement from one reporting date to the other", () => {
    for (const movement of movements) {
      expect(movement.openingDate).toBe("2025-12-31");
      expect(movement.closingDate).toBe("2026-12-31");
      expect(movement.comparable).toBe(true);
    }
  });

  it("reports everything in the presentation currency, whatever the entity keeps", () => {
    for (const movement of movements) {
      expect(movement.presentation.code).toBe("GBP");
      expect(movement.opening.currency.code).toBe("GBP");
      expect(movement.result.currency.code).toBe("GBP");
    }
    expect(movements.find((m) => m.entity === "HN")?.functional.code).toBe("EUR");
    expect(movements.find((m) => m.entity === "HS")?.functional.code).toBe("USD");
  });
});

describe("what the currency did, separately from what the company did", () => {
  const { prior, current } = priorAndCurrent();
  const rates = demo.groupRates();
  const movements = netAssetsMovements(prior, current, { rates });
  const nord = movements.find((m) => m.entity === "HN") as (typeof movements)[number];
  const systems = movements.find((m) => m.entity === "HS") as (typeof movements)[number];

  it("holds the investment in a sub-subsidiary at what was paid, not at the closing rate", () => {
    // Nord's opening net assets of 355,500 include its investment in Systems,
    // carried at 150,000 EUR x 0.8580 = 128,700. Sterling strengthened from
    // 0.84 to 0.82, and only the 226,800 held at a closing rate moves with it:
    // 226,800 / 0.84 x 0.82 = 221,400, a fall of 5,400.
    expect(nord.translationEffect.toDecimalString()).toBe("-5400.00");
  });

  it("moves the whole of an entity that holds nothing historically", () => {
    // Systems has no investments, so all 188,650 retranslates:
    // 188,650 / 0.77 x 0.75 = 183,750.
    expect(systems.openingRetranslated.toDecimalString()).toBe("183750.00");
    expect(systems.translationEffect.toDecimalString()).toBe("-4900.00");
  });

  it("leaves only the average-versus-closing difference on the result in `other`", () => {
    // Systems earned 380,000 - 268,000 - 36,000 = 76,000 USD in 2026. Carried
    // at the closing rate that is 57,000; the income statement translates it at
    // the average and gets 57,999.46. The 999.46 has to land somewhere, and it
    // lands here rather than in the currency line, where it is not a currency
    // movement on an opening balance.
    expect(systems.result.toDecimalString()).toBe("57999.46");
    expect(systems.other.toDecimalString()).toBe("-999.46");
    expect(systems.result.plus(systems.other).toDecimalString()).toBe("57000.00");
  });

  it("does the same for the euro company, whose result is much smaller", () => {
    // 560,000 - 395,000 - 84,000 - 72,289.16 = 8,710.84 EUR, which at the
    // closing rate of 0.82 is 7,142.89.
    expect(nord.result.plus(nord.other).toDecimalString()).toBe("7142.89");
  });

  it("would produce no currency line at all if the rate had not moved", () => {
    const group = demo.groupStructure();
    const ledgers = demo.groupLedgers();
    const flat = RateTable.of(
      [
        { date: "2024-01-05", base: "EUR", quote: "GBP", rate: "0.8500" },
        { date: "2024-02-01", base: "USD", quote: "GBP", rate: "0.7800" },
      ],
      { maxStaleDays: 2000 },
    );
    const options = {
      rates: flat,
      intercompany: demo.groupIntercompany(),
      acquisitions: demo.groupAcquisitions(),
    };
    const before = consolidate(group, ledgers, {
      ...options,
      asAt: demo.GROUP_PRIOR_AS_AT,
      period: demo.groupPriorPeriod(),
    });
    const after = consolidate(group, ledgers, {
      ...options,
      asAt: demo.GROUP_AS_AT,
      period: demo.groupPeriod(),
    });
    for (const movement of netAssetsMovements(before, after, { rates: flat })) {
      expect(movement.translationEffect.isZero).toBe(true);
      expect(movement.openingRetranslated.equals(movement.opening)).toBe(true);
    }
  });
});

describe("an entity whose books are already in the group's currency", () => {
  it("has no currency line, because there is no rate to apply", () => {
    const chart = groupChart("GBP");
    const entry = (id: string, date: string, debit: string, credit: string, amount: string) =>
      JournalEntry.simple(
        { id, date, narration: id, debit, credit, amount: Money.parse(amount, GBP) },
        chart,
      );
    const parent = Ledger.from(
      [
        entry("P1", "2025-01-01", "1110", "3100", "500000.00"),
        entry("P2", "2025-06-30", "1230", "1110", "80000.00"),
      ],
      chart,
    );
    const sub = Ledger.from(
      [
        entry("S1", "2025-01-01", "1110", "3100", "100000.00"),
        entry("S2", "2025-09-30", "1110", "4100", "40000.00"),
        entry("S3", "2025-12-31", "4100", "3200", "40000.00"),
        entry("S4", "2026-09-30", "1110", "4100", "60000.00"),
      ],
      chart,
    );
    const group = GroupStructure.build(
      [
        { code: "P", name: "Parent", currency: GBP },
        { code: "S", name: "Sub", currency: GBP, parent: "P", holding: "75", acquired: "2025-01-01" },
      ],
      { presentation: "GBP", name: "Sterling only" },
    );
    const rates = RateTable.of([], { maxStaleDays: 2000 });
    const options = {
      rates,
      acquisitions: [{ entity: "S", consideration: Money.parse("80000.00", GBP) }],
    };
    const before = consolidate(group, { P: parent, S: sub }, {
      ...options,
      asAt: "2025-12-31",
      period: dateRange("2025-01-01", "2025-12-31"),
    });
    const after = consolidate(group, { P: parent, S: sub }, {
      ...options,
      asAt: "2026-12-31",
      period: dateRange("2026-01-01", "2026-12-31"),
    });
    const movement = netAssetsMovement("S", before, after, { rates });
    expect(movement.translationEffect.isZero).toBe(true);
    expect(movement.other.isZero).toBe(true);
    expect(movement.result.toDecimalString()).toBe("60000.00");
    expect(movement.opening.toDecimalString()).toBe("140000.00");
    expect(movement.closing.toDecimalString()).toBe("200000.00");
  });
});

describe("the outside stake, rolled forward", () => {
  const { prior, current } = priorAndCurrent();
  const rates = demo.groupRates();
  const schedule = nciSchedule(prior, current, { rates });

  it("opens at what the comparative consolidation reported", () => {
    expect(schedule.opening.equals(prior.nonControllingInterest)).toBe(true);
  });

  it("closes at what this consolidation reports, not at what the lines add to", () => {
    expect(schedule.closing.equals(current.nonControllingInterest)).toBe(true);
  });

  it("ties on this group, with nothing unexplained", () => {
    expect(schedule.unexplained.toDecimalString()).toBe("0.00");
    expect(schedule.reconciles).toBe(true);
    expect(schedule.rolledForward.equals(schedule.closing)).toBe(true);
  });

  it("takes the share of the result from the entry the consolidation actually posted", () => {
    const line = schedule.lines.find((l) => l.label.includes("result"));
    const posted = current.workings.reduce(
      (running, w) => running.plus(w.nciProfitShare),
      Money.zero(GBP),
    );
    expect(line?.amount.equals(posted)).toBe(true);
    expect(line?.amount.toDecimalString()).toBe("24651.27");
  });

  it("shows the currency's effect on the outside stake as its own line", () => {
    const line = schedule.lines.find((l) => l.label.includes("translation"));
    // 20% of Nord's -5,400 is -1,080; 40% of Systems' -4,900 is -1,960.
    expect(line?.amount.toDecimalString()).toBe("-3040.00");
  });

  it("drops a component that is nil rather than printing a line of zeroes", () => {
    expect(schedule.lines.every((l) => !l.amount.isZero)).toBe(true);
    expect(schedule.lines.some((l) => l.label.includes("acquisition"))).toBe(false);
  });

  it("splits the same total per entity", () => {
    const perEntity = nciMovements(prior, current, { rates });
    expect(perEntity.map((m) => m.entity)).toEqual(["HN", "HS"]);
    const closing = perEntity.reduce((running, m) => running.plus(m.closing), Money.zero(GBP));
    expect(closing.equals(current.nonControllingInterest)).toBe(true);
    for (const movement of perEntity) {
      expect(movement.arisingOnAcquisition.isZero).toBe(true);
    }
  });

  it("applies each entity's own fraction, not the group's average", () => {
    const perEntity = nciMovements(prior, current, { rates });
    const nord = perEntity.find((m) => m.entity === "HN");
    const systems = perEntity.find((m) => m.entity === "HS");
    expect(nord?.shareOfTranslation.toDecimalString()).toBe("-1080.00");
    expect(systems?.shareOfTranslation.toDecimalString()).toBe("-1960.00");
  });
});

describe("the translation reserve, rolled forward", () => {
  const { prior, current } = priorAndCurrent();
  const schedule = translationReserveSchedule(prior, current);

  it("opens and closes at the two reported reserves", () => {
    expect(schedule.opening.equals(prior.translationReserve)).toBe(true);
    expect(schedule.closing.equals(current.translationReserve)).toBe(true);
  });

  it("ties exactly, because there is nothing to apportion and so nothing to round", () => {
    expect(schedule.unexplained.toDecimalString()).toBe("0.00");
    expect(schedule.reconciles).toBe(true);
  });

  it("names the entity behind each movement", () => {
    expect(schedule.lines.map((l) => l.label)).toEqual([
      "HN — movement on retranslation",
      "HS — movement on retranslation",
    ]);
  });

  it("adds the lines to the difference between the two reserves", () => {
    const sum = schedule.lines.reduce((running, l) => running.plus(l.amount), Money.zero(GBP));
    expect(sum.equals(current.translationReserve.minus(prior.translationReserve))).toBe(true);
  });
});

describe("what it refuses and what it reports", () => {
  const { prior, current } = priorAndCurrent();
  const rates = demo.groupRates();

  it("refuses to compare two consolidations presented in different currencies", () => {
    const group = demo.groupStructure();
    const inEuros = GroupStructure.build(
      [
        { code: "HH", name: "Halden Holdings", currency: GBP },
        { code: "HN", name: "Halden Nord GmbH", currency: EUR, parent: "HH", holding: "80", acquired: "2025-01-02" },
        { code: "HS", name: "Halden Systems Inc", currency: USD, parent: "HN", holding: "75", acquired: "2025-01-02" },
      ],
      { presentation: "EUR", name: "The Halden Group" },
    );
    const euroPrior = consolidate(inEuros, demo.groupLedgers(), {
      ...shared(),
      asAt: demo.GROUP_PRIOR_AS_AT,
      period: demo.groupPriorPeriod(),
    });
    expect(() => netAssetsMovement("HN", euroPrior, current, { rates })).toThrow(/different currencies/);
    expect(group.presentation.code).toBe("GBP");
  });

  it("treats an entity absent from the comparative as an acquisition in the period", () => {
    const thinner = { ...prior, workings: prior.workings.filter((w) => w.entity !== "HS") };
    const movements = netAssetsMovements(thinner as typeof prior, current, { rates });
    const systems = movements.find((m) => m.entity === "HS");
    expect(systems?.comparable).toBe(false);
    expect(systems?.opening.isZero).toBe(true);
    expect(systems?.translationEffect.isZero).toBe(true);

    const stake = nciMovements(thinner as typeof prior, current, { rates }).find(
      (m) => m.entity === "HS",
    );
    expect(stake?.opening.isZero).toBe(true);
    expect(stake?.shareOfResult.isZero).toBe(true);
    expect(stake?.arisingOnAcquisition.isZero).toBe(false);
    expect(stake?.unexplained.toDecimalString()).toBe("0.00");
  });
});

describe("how the schedules read", () => {
  const { prior, current } = priorAndCurrent();
  const rates = demo.groupRates();

  it("prints an opening line, the components, and a closing line", () => {
    const text = renderMovementSchedule(nciSchedule(prior, current, { rates }));
    expect(text).toContain("Non-controlling interest");
    expect(text).toContain("At the start of the period");
    expect(text).toContain("At the reporting date");
    expect(text).toContain("174052.58");
    expect(text).not.toContain("Not explained");
  });

  it("prints the unexplained line only when there is something unexplained", () => {
    const bent = { ...current, nonControllingInterest: current.nonControllingInterest.plus(Money.parse("1.00", GBP)) };
    const schedule = nciSchedule(prior, bent as typeof current, { rates });
    expect(schedule.reconciles).toBe(false);
    expect(schedule.unexplained.toDecimalString()).toBe("1.00");
    expect(renderMovementSchedule(schedule)).toContain("Not explained by the above");
  });

  it("tabulates the net-asset movement with a column per component", () => {
    const text = renderNetAssetsMovements(
      netAssetsMovements(prior, current, { rates }),
      (entity) => current.group.get(entity).name,
    );
    expect(text).toContain("Movement in net assets");
    expect(text).toContain("Currency");
    expect(text).toContain("Halden Nord GmbH");
    expect(text).toContain("357242.89");
  });

  it("says so plainly where an entity has no comparative", () => {
    const thinner = { ...prior, workings: [] };
    const text = renderNetAssetsMovements(
      netAssetsMovements(thinner as typeof prior, current, { rates }),
      (entity) => current.group.get(entity).name,
    );
    expect(text).toContain("acquired in the period");
  });
});
