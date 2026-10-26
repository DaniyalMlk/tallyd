import { describe, expect, it } from "vitest";
import { dateRange } from "../src/ledger/date.js";
import { EUR, GBP } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { averageRate } from "../src/fx/average.js";
import { type Consolidation, consolidate } from "../src/group/consolidate.js";
import {
  EUR_CHART,
  FOREIGN_ACQUISITION,
  FOREIGN_GROUP,
  FOREIGN_PARENT,
  FOREIGN_SUB,
  MID_YEAR_FOREIGN,
  MID_YEAR_SOLD,
  MOVING_RATES,
  ledgerOf,
} from "./foreignGroup.js";

const PERIOD = dateRange("2026-01-01", "2026-12-31");
const LEDGERS = { P: FOREIGN_PARENT, S: FOREIGN_SUB };

/** The average EUR/GBP rate over a span, independently of the consolidation. */
function average(from: string, to: string): string {
  return averageRate(MOVING_RATES, EUR, GBP, from, to, "daily").rate.toString();
}

function acquiredMidYear(wholePeriodRegardless = false): Consolidation {
  return consolidate(MID_YEAR_FOREIGN, LEDGERS, {
    asAt: "2026-12-31",
    period: PERIOD,
    rates: MOVING_RATES,
    averageMethod: "daily",
    ...(wholePeriodRegardless ? { wholePeriodRegardless } : {}),
    acquisitions: [{ entity: "S", consideration: Money.parse("80000.00", GBP) }],
  });
}

// The shared fixture puts all of its trading on 2026-06-30, which is after a
// 1 April disposal and therefore outside that window entirely — no row on the
// average basis and no average rate to compare. The symmetry pair needs books
// with a result in *both* halves of the year, so it gets its own: 5,000 EUR
// earned in February and 5,000 in August.
const SPREAD_SUB = ledgerOf(EUR_CHART, EUR, [
  { id: "S-CAP", date: "2024-12-31", narration: "Capital", debit: "1110", credit: "3100", amount: "60000.00" },
  { id: "S-RES", date: "2025-12-31", narration: "Reserves brought forward", debit: "1110", credit: "3200", amount: "20000.00" },
  { id: "S-INC-Q1", date: "2026-02-15", narration: "Sales", debit: "1110", credit: "4100", amount: "20000.00" },
  { id: "S-EXP-Q1", date: "2026-02-15", narration: "Cost of sales", debit: "5100", credit: "1110", amount: "15000.00" },
  { id: "S-INC-Q3", date: "2026-08-15", narration: "Sales", debit: "1110", credit: "4100", amount: "20000.00" },
  { id: "S-EXP-Q3", date: "2026-08-15", narration: "Cost of sales", debit: "5100", credit: "1110", amount: "15000.00" },
]);
const SPREAD_LEDGERS = { P: FOREIGN_PARENT, S: SPREAD_SUB };

function spreadAcquiredMidYear(): Consolidation {
  return consolidate(MID_YEAR_FOREIGN, SPREAD_LEDGERS, {
    asAt: "2026-12-31",
    period: PERIOD,
    rates: MOVING_RATES,
    averageMethod: "daily",
    acquisitions: [{ entity: "S", consideration: Money.parse("80000.00", GBP) }],
  });
}

function soldMidYear(): Consolidation {
  return consolidate(MID_YEAR_SOLD, SPREAD_LEDGERS, {
    asAt: "2026-12-31",
    period: PERIOD,
    rates: MOVING_RATES,
    averageMethod: "daily",
    acquisitions: [{ entity: "S", consideration: Money.parse("80000.00", GBP) }],
    disposals: [{ entity: "S", proceeds: Money.parse("100000.00", GBP) }],
  });
}

function contribution(c: Consolidation) {
  const found = c.aggregation.entities.find((e) => e.entity === "S");
  expect(found).toBeDefined();
  return found!;
}

describe("the two candidate averages genuinely differ", () => {
  // Everything below is a claim about which of two rates was used, so the
  // first thing to establish is that they are two rates. They are, because
  // EUR/GBP rises through 2026 in this fixture; on a flat table every
  // assertion in this file would hold whatever the engine did.
  it("is 1.18% between the whole year and the nine months from 2 April", () => {
    expect(average("2026-01-01", "2026-12-31")).toBe("1 EUR = 0.843726 GBP");
    expect(average("2026-04-02", "2026-12-31")).toBe("1 EUR = 0.853650 GBP");
    const gap = (0.85365 - 0.843726) / 0.843726;
    expect(gap).toBeGreaterThan(0.01);
    expect(gap).toBeCloseTo(0.0118, 4);
  });

  it("is a wider 3.5% between the whole year and the three months to 1 April", () => {
    expect(average("2026-01-01", "2026-04-01")).toBe("1 EUR = 0.813846 GBP");
    const gap = (0.843726 - 0.813846) / 0.843726;
    expect(gap).toBeCloseTo(0.0354, 4);
    // Wider than the acquisition end's 1.18%, and in the other direction: the
    // early months of this fixture are the cheap ones. So the two halves of
    // the symmetry are not the same number and cannot be confused.
    expect(gap).toBeGreaterThan((0.85365 - 0.843726) / 0.843726);
  });
});

describe("a company acquired part-way through the period", () => {
  it("translates its result at the average over the window, not the period", () => {
    const window = contribution(acquiredMidYear()).translation;
    expect(window.period).toEqual({ from: "2026-04-02", to: "2026-12-31" });
    expect(window.averageRate?.toString()).toBe(average("2026-04-02", "2026-12-31"));
  });

  it("gets a result 1.18% larger than the whole-period average gave", () => {
    // 10,000 EUR of post-acquisition result. At the window average that is
    // 8,536.50; at the whole year's it was 8,437.26 — a figure mixing in
    // rates from three months whose result had already been taken out as
    // pre-acquisition.
    expect(acquiredMidYear().workings[0]?.profitForPeriod.toString()).toBe("8536.50 GBP");
    expect(
      Money.parse("10000.00", EUR).times("0.853650", "half-even").toDecimalString(),
    ).toBe("8536.50");
  });

  it("says in the window which months it is averaging over, and why", () => {
    const control = contribution(acquiredMidYear()).control;
    expect(control.acquiredDuring).toBe(true);
    expect(control.window).toEqual({ from: "2026-04-02", to: "2026-12-31" });
    expect(contribution(acquiredMidYear()).windowApplied).toBe(true);
  });
});

describe("the two ends of a company's life are treated the same way", () => {
  // This is the point of the change. A disposal already averaged over its
  // window; an acquisition did not, and the asymmetry was in the same engine
  // on the same books.
  it("averages over whichever part of the year was the group's", () => {
    // The same books both times, so the only thing that differs is which part
    // of the year the group owned them for.
    const bought = contribution(spreadAcquiredMidYear()).translation;
    const sold = contribution(soldMidYear()).translation;

    expect(bought.period).toEqual({ from: "2026-04-02", to: "2026-12-31" });
    expect(sold.period).toEqual({ from: "2026-01-01", to: "2026-04-01" });

    // Each takes the average over its own window, computed independently of
    // the consolidation.
    expect(bought.averageRate?.toString()).toBe(average("2026-04-02", "2026-12-31"));
    expect(sold.averageRate?.toString()).toBe(average("2026-01-01", "2026-04-01"));

    // And neither takes the whole year's, which is what the asymmetry looked
    // like: one of these two used to.
    const wholeYear = average("2026-01-01", "2026-12-31");
    expect(bought.averageRate?.toString()).not.toBe(wholeYear);
    expect(sold.averageRate?.toString()).not.toBe(wholeYear);
  });

  it("covers the year between them, with the day of the event in one half", () => {
    // The windows abut rather than overlap: control is obtained on 1 April in
    // one and lost on 1 April in the other, and that day belongs to the seller
    // both times, so the two spans together are the year and share no day.
    const bought = contribution(spreadAcquiredMidYear()).translation.period;
    const sold = contribution(soldMidYear()).translation.period;
    expect(sold.from).toBe("2026-01-01");
    expect(bought.to).toBe("2026-12-31");
    expect(sold.to).toBe("2026-04-01");
    expect(bought.from).toBe("2026-04-02");
  });
});

describe("asking for the whole period regardless", () => {
  it("takes the whole period's average with it", () => {
    // The option exists so the difference can be shown rather than described,
    // so it has to be shown honestly: a result that includes the
    // pre-acquisition months belongs at an average that includes them too.
    // Half-applying the window would produce a figure that is neither.
    const whole = contribution(acquiredMidYear(true));
    expect(whole.windowApplied).toBe(false);
    expect(whole.translation.period).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(whole.translation.averageRate?.toString()).toBe(
      average("2026-01-01", "2026-12-31"),
    );
  });

  it("is a different answer from the windowed one, which is the point of it", () => {
    const windowed = acquiredMidYear().workings[0]?.profitForPeriod;
    const whole = acquiredMidYear(true).workings[0]?.profitForPeriod;
    expect(windowed?.toString()).toBe("8536.50 GBP");
    expect(whole?.toString()).toBe("8437.26 GBP");
    expect(whole?.equals(windowed!)).toBe(false);
  });
});

describe("a company held for the whole period is unaffected", () => {
  it("averages over the period, because its window is the period", () => {
    const c = consolidate(FOREIGN_GROUP, LEDGERS, {
      asAt: "2026-12-31",
      period: PERIOD,
      rates: MOVING_RATES,
      averageMethod: "daily",
      acquisitions: [FOREIGN_ACQUISITION],
    });
    const held = contribution(c);
    expect(held.control.whole).toBe(true);
    expect(held.translation.period).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(held.translation.averageRate?.toString()).toBe(
      average("2026-01-01", "2026-12-31"),
    );
  });
});
