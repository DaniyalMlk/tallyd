import { describe, expect, it } from "vitest";
import { dateRange } from "../src/ledger/date.js";
import { EUR, GBP } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { GroupStructure } from "../src/group/structure.js";
import {
  type AcquisitionInput,
  type GoodwillImpairment,
} from "../src/group/acquisition.js";
import { type Consolidation, consolidate } from "../src/group/consolidate.js";
import { goodwillSchedule, renderMovementSchedule } from "../src/group/movement.js";
import {
  FOREIGN_ACQUISITION,
  FOREIGN_GROUP,
  FOREIGN_LEDGERS,
  MOVING_RATES,
} from "./foreignGroup.js";

const FAIR_VALUE: AcquisitionInput = {
  entity: "S",
  consideration: Money.parse("80000.00", GBP),
  nciMeasurement: "fair-value",
  nciFairValue: Money.parse("15000.00", EUR),
};

const HISTORY: readonly GoodwillImpairment[] = [
  { entity: "S", amount: Money.parse("4000.00", EUR), on: "2025-12-31" },
  { entity: "S", amount: Money.parse("6000.00", EUR), on: "2026-06-30" },
];

function at(
  end: string,
  impairments: readonly GoodwillImpairment[] = HISTORY,
  acquisition: AcquisitionInput = FAIR_VALUE,
  group: GroupStructure = FOREIGN_GROUP,
  extra: { disposals?: readonly { entity: string; proceeds: Money }[] } = {},
): Consolidation {
  return consolidate(group, FOREIGN_LEDGERS, {
    asAt: end,
    period: dateRange(`${Number(end.slice(0, 4))}-01-01`, end),
    rates: MOVING_RATES,
    acquisitions: [acquisition],
    goodwillImpairments: impairments,
    ...(extra.disposals === undefined ? {} : { disposals: extra.disposals }),
  });
}

describe("the goodwill account rolled forward", () => {
  const schedule = () => goodwillSchedule(at("2025-12-31"), at("2026-12-31"));

  it("reconciles against what the account says, not against its own lines", () => {
    const s = schedule();
    expect(s.what).toBe("Goodwill");
    expect(s.opening.toString()).toBe("40800.00 GBP");
    expect(s.closing.toString()).toBe("40500.00 GBP");
    expect(s.closing.equals(at("2026-12-31").goodwill)).toBe(true);
    expect(s.unexplained.isZero).toBe(true);
    expect(s.reconciles).toBe(true);
  });

  it("names each thing that moved it, at the figure that thing moved it by", () => {
    const s = schedule();
    expect(s.lines.map((l) => l.label)).toEqual([
      "S — written off",
      "S — retranslated",
    ]);
    // The write-off at the rate it was recognised at — 6,000 EUR at the 30
    // June rate of 0.85 — and the retranslation as everything the closing rate
    // did on top of that. Taking the write-off at the closing rate instead
    // would make both lines wrong while still adding to the right total.
    expect(s.lines[0]?.amount.toString()).toBe("-5100.00 GBP");
    expect(s.lines[1]?.amount.toString()).toBe("4800.00 GBP");
    expect(Money.parse("6000.00", EUR).times("0.85", "half-even").toDecimalString()).toBe("5100.00");
  });

  it("prints an opening line, the components and a closing line", () => {
    const text = renderMovementSchedule(schedule());
    expect(text).toContain("Goodwill");
    expect(text).toContain("At the start of the period");
    expect(text).toContain("S — written off");
    expect(text).toContain("S — retranslated");
    expect(text).toContain("At the reporting date");
    expect(text).not.toContain("Not explained");
  });
});

describe("the reason the schedule exists", () => {
  // Two of the four causes cancelling is not a hypothetical: a write-off and a
  // favourable rate move of the same size leave the account exactly where it
  // was, and a comparative column showing goodwill flat cannot tell that from
  // nothing having happened. They are not the same news.
  it("shows a write-off and a rate move that cancel each other out", () => {
    // 4,800 of the 2026 rate move is what the 2025-only history leaves. Write
    // off the amount that is worth 4,800 at the rate on the day and the
    // account comes out flat.
    const cancelling: readonly GoodwillImpairment[] = [
      { entity: "S", amount: Money.parse("4000.00", EUR), on: "2025-12-31" },
      // Chosen so the account comes out where it started: 51,000 EUR is left
      // after the 2025 write-off, and 40,800 GBP at the 0.90 close is
      // 45,333.33 EUR of it, so 5,666.67 has to go.
      { entity: "S", amount: Money.parse("5666.67", EUR), on: "2026-12-31" },
    ];
    const prior = at("2025-12-31", cancelling);
    const current = at("2026-12-31", cancelling);
    const s = goodwillSchedule(prior, current);

    // Flat to within a minor unit, because 4,800/0.9 is not a whole number of
    // cents. The point is not the penny: it is that the movement column of a
    // comparative would read as nothing having happened.
    expect(
      Number(current.goodwill.toDecimalString()) - Number(prior.goodwill.toDecimalString()),
    ).toBeCloseTo(0, 1);

    // And the schedule says what actually happened: two figures of about 4,800
    // with opposite signs.
    const written = Number(
      s.lines.find((l) => l.label.includes("written off"))!.amount.toDecimalString(),
    );
    const retranslated = Number(
      s.lines.find((l) => l.label.includes("retranslated"))!.amount.toDecimalString(),
    );
    expect(written).toBeLessThan(-4700);
    expect(retranslated).toBeGreaterThan(4700);
    expect(written + retranslated).toBeCloseTo(0, 1);
    expect(s.reconciles).toBe(true);
  });
});

describe("a company arriving and a company leaving", () => {
  const MID_YEAR = GroupStructure.build(
    [
      { code: "P", name: "Parent Ltd", currency: GBP },
      { code: "S", name: "Sub GmbH", currency: EUR, parent: "P", holding: "80", acquired: "2026-04-01" },
    ],
    { presentation: "GBP", name: "Arrived" },
  );
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
    { presentation: "GBP", name: "Left" },
  );

  it("shows the whole of it arising when the company is new to the page", () => {
    // The prior consolidation has no S at all, so everything about its
    // goodwill arises in the period — and split the same three ways as for a
    // company already there, so a first period reads like a later one rather
    // than as one lump.
    // The prior year's group is the parent on its own: S was not a member of
    // it, and the consolidation rightly refuses to be asked about a company
    // bought after the date it is being prepared at.
    const PARENT_ONLY = GroupStructure.build([{ code: "P", name: "Parent Ltd", currency: GBP }], {
      presentation: "GBP",
      name: "Arrived",
    });
    const prior = consolidate(PARENT_ONLY, { P: FOREIGN_LEDGERS.P }, {
      asAt: "2025-12-31",
      period: dateRange("2025-01-01", "2025-12-31"),
      rates: MOVING_RATES,
      acquisitions: [],
    });
    const current = at("2026-12-31", [], FOREIGN_ACQUISITION, MID_YEAR);
    const s = goodwillSchedule(prior, current);
    expect(prior.goodwill.isZero).toBe(true);
    expect(s.lines.map((l) => l.label)).toEqual([
      "S — arising on acquisition",
      "S — retranslated",
    ]);
    expect(s.closing.equals(current.goodwill)).toBe(true);
    expect(s.reconciles).toBe(true);
  });

  it("shows it derecognised when the company leaves", () => {
    const prior = at("2025-12-31", [], FOREIGN_ACQUISITION);
    const current = at("2026-12-31", [], FOREIGN_ACQUISITION, SOLD, {
      disposals: [{ entity: "S", proceeds: Money.parse("120000.00", GBP) }],
    });
    const s = goodwillSchedule(prior, current);
    expect(current.goodwill.isZero).toBe(true);
    expect(s.lines.some((l) => l.label === "S — derecognised on disposal")).toBe(true);
    // 52,000 EUR at the 0.87 of the day control was lost.
    const removed = s.lines.find((l) => l.label.includes("derecognised"));
    expect(removed?.amount.toString()).toBe("-45240.00 GBP");
    expect(s.unexplained.isZero).toBe(true);
    expect(s.reconciles).toBe(true);
  });
});

describe("the comparative carries it", () => {
  it("counts it towards whether the comparative hangs together", () => {
    // `sound` is the one flag a reader checks, so a schedule that did not
    // reconcile but was not in it would be a schedule nobody noticed.
    const s = goodwillSchedule(at("2025-12-31"), at("2026-12-31"));
    expect(s.reconciles).toBe(true);
    const bent = { ...at("2026-12-31"), goodwill: Money.parse("1.00", GBP) };
    const broken = goodwillSchedule(at("2025-12-31"), bent as Consolidation);
    expect(broken.reconciles).toBe(false);
    expect(broken.unexplained.isZero).toBe(false);
  });
});
