import { describe, expect, it } from "vitest";
import { EUR, GBP, USD } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { GroupStructure } from "../src/group/structure.js";
import { consolidate } from "../src/group/consolidate.js";
import {
  compareConsolidations,
  consolidateComparative,
  renderComparative,
} from "../src/group/comparative.js";
import * as demo from "../src/demo/group.js";

const shared = () => ({
  rates: demo.groupRates(),
  intercompany: demo.groupIntercompany(),
  acquisitions: demo.groupAcquisitions(),
});

function comparative(includeZero?: boolean) {
  return consolidateComparative(demo.groupStructure(), demo.groupLedgers(), {
    current: { ...shared(), asAt: demo.GROUP_AS_AT, period: demo.groupPeriod() },
    prior: { ...shared(), asAt: demo.GROUP_PRIOR_AS_AT, period: demo.groupPriorPeriod() },
    ...(includeZero === undefined ? {} : { includeZero }),
  });
}

describe("consolidating the same books at two dates", () => {
  const result = comparative();

  it("needs nothing kept from last time: the same ledgers answer both questions", () => {
    expect(result.asAt).toBe("2026-12-31");
    expect(result.comparativeAsAt).toBe("2025-12-31");
    expect(result.current.balanced).toBe(true);
    expect(result.prior.balanced).toBe(true);
  });

  it("hangs together on both dates and both schedules tie", () => {
    expect(result.sound).toBe(true);
    expect(result.current.residual.isZero).toBe(true);
    expect(result.prior.residual.isZero).toBe(true);
  });

  it("consolidates the same three companies at either date", () => {
    expect(result.entered).toEqual([]);
    expect(result.left).toEqual([]);
    expect(result.current.aggregation.entities).toHaveLength(3);
    expect(result.prior.aggregation.entities).toHaveLength(3);
  });

  it("presents both columns in the group's currency", () => {
    expect(result.presentation.code).toBe("GBP");
    for (const row of result.rows) {
      expect(row.current.currency.code).toBe("GBP");
      expect(row.prior.currency.code).toBe("GBP");
    }
  });
});

describe("the comparative trial balance", () => {
  const result = comparative();
  const row = (account: string) => result.rows.find((r) => r.account === account);

  it("is drawn from the two consolidated ledgers, so the eliminations are already in it", () => {
    // The loan and the trading eliminate to nil, so neither intercompany
    // account survives into a set of group accounts.
    expect(row("1190")).toBeUndefined();
    expect(row("2190")).toBeUndefined();
    expect(row("4950")).toBeUndefined();
    expect(row("5960")).toBeUndefined();
  });

  it("carries goodwill unchanged, because nothing impaired it", () => {
    expect(row("1290")?.current.toDecimalString()).toBe("113436.00");
    expect(row("1290")?.prior.toDecimalString()).toBe("113436.00");
    expect(row("1290")?.movement.isZero).toBe(true);
  });

  it("computes each movement as this period less last", () => {
    for (const line of result.rows) {
      expect(line.movement.equals(line.current.minus(line.prior))).toBe(true);
    }
  });

  it("marks an account that appears for the first time", () => {
    // The intercompany balances only disagree in 2026, so items in transit is
    // a 2026 account.
    const transit = row("1195");
    expect(transit?.newThisPeriod).toBe(true);
    expect(transit?.prior.isZero).toBe(true);
    expect(transit?.current.toDecimalString()).toBe("53547.55");
  });

  it("sorts by account code, so the two columns line up with a printed statement", () => {
    const codes = result.rows.map((r) => r.account);
    expect([...codes].sort((a, b) => a.localeCompare(b))).toEqual(codes);
  });

  it("leaves out rows that are nil in both columns unless asked", () => {
    const withZeroes = comparative(true);
    expect(withZeroes.rows.length).toBeGreaterThan(result.rows.length);
    expect(withZeroes.rows.some((r) => r.current.isZero && r.prior.isZero)).toBe(true);
    expect(result.rows.every((r) => !r.current.isZero || !r.prior.isZero)).toBe(true);
  });

  it("shows the outside stake growing by exactly what the schedule explains", () => {
    const stake = row("3400");
    // Held as a credit, so the reported figure is the negation.
    expect(stake?.current.negated().equals(result.current.nonControllingInterest)).toBe(true);
    expect(stake?.movement.negated().equals(result.nci.closing.minus(result.nci.opening))).toBe(
      true,
    );
  });
});

describe("the schedules that come with it", () => {
  const result = comparative();

  it("carries the net-asset movement for every consolidated subsidiary", () => {
    expect(result.netAssets.map((m) => m.entity)).toEqual(["HN", "HS"]);
  });

  it("carries the outside stake both per entity and as one schedule", () => {
    expect(result.nciByEntity).toHaveLength(2);
    expect(result.nci.closing.equals(result.current.nonControllingInterest)).toBe(true);
    expect(result.nci.reconciles).toBe(true);
  });

  it("carries the translation reserve on the same shape", () => {
    expect(result.translationReserve.what).toBe("Translation reserve");
    expect(result.translationReserve.reconciles).toBe(true);
    expect(result.translationReserve.opening.equals(result.prior.translationReserve)).toBe(true);
  });
});

describe("what it will not compare", () => {
  const base = comparative();

  it("refuses two consolidations in different presentation currencies", () => {
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
    expect(() =>
      compareConsolidations(euroPrior, base.current, { rates: demo.groupRates() }),
    ).toThrow(/different currencies/);
  });

  it("refuses two consolidations of different groups", () => {
    const other = GroupStructure.build(
      [
        { code: "HH", name: "Halden Holdings", currency: GBP },
        { code: "HN", name: "Halden Nord GmbH", currency: EUR, parent: "HH", holding: "80", acquired: "2025-01-02" },
        { code: "HS", name: "Halden Systems Inc", currency: USD, parent: "HN", holding: "75", acquired: "2025-01-02" },
      ],
      { presentation: "GBP", name: "Somebody Else Plc" },
    );
    const theirs = consolidate(other, demo.groupLedgers(), {
      ...shared(),
      asAt: demo.GROUP_PRIOR_AS_AT,
      period: demo.groupPriorPeriod(),
    });
    expect(() => compareConsolidations(theirs, base.current, { rates: demo.groupRates() })).toThrow(
      /not the same group/,
    );
  });

  it("refuses a comparative that is not before the reporting date", () => {
    expect(() =>
      compareConsolidations(base.current, base.current, { rates: demo.groupRates() }),
    ).toThrow(/not before the reporting date/);
    expect(() =>
      compareConsolidations(base.current, base.prior, { rates: demo.groupRates() }),
    ).toThrow(/not before the reporting date/);
  });
});

describe("an entity that was not there last year", () => {
  it("is reported as having entered the group rather than quietly doubling a line", () => {
    const group = demo.groupStructure();
    const ledgers = demo.groupLedgers();
    const result = consolidateComparative(group, ledgers, {
      current: { ...shared(), asAt: demo.GROUP_AS_AT, period: demo.groupPeriod() },
      prior: { ...shared(), asAt: demo.GROUP_PRIOR_AS_AT, period: demo.groupPriorPeriod() },
    });
    // Nothing entered on these books; the reporting is exercised by faking the
    // prior consolidation's entity list, which is what a real acquisition
    // would produce.
    const thinner = {
      ...result.prior,
      aggregation: {
        ...result.prior.aggregation,
        entities: result.prior.aggregation.entities.filter((c) => c.entity !== "HS"),
      },
      workings: result.prior.workings.filter((w) => w.entity !== "HS"),
    };
    const compared = compareConsolidations(thinner as typeof result.prior, result.current, {
      rates: demo.groupRates(),
    });
    expect(compared.entered).toEqual(["HS"]);
    expect(compared.left).toEqual([]);
    expect(renderComparative(compared)).toContain("is consolidated this period and was not last");
    const stake = compared.nciByEntity.find((m) => m.entity === "HS");
    expect(stake?.arisingOnAcquisition.isZero).toBe(false);
  });

  it("reports an entity that has gone the other way too", () => {
    const result = comparative();
    const thinner = {
      ...result.current,
      aggregation: {
        ...result.current.aggregation,
        entities: result.current.aggregation.entities.filter((c) => c.entity !== "HS"),
      },
      workings: result.current.workings.filter((w) => w.entity !== "HS"),
    };
    const compared = compareConsolidations(result.prior, thinner as typeof result.current, {
      rates: demo.groupRates(),
    });
    expect(compared.left).toEqual(["HS"]);
    expect(renderComparative(compared)).toContain("was consolidated last period and is not this one");
  });
});

describe("how it reads", () => {
  const result = comparative();
  const text = renderComparative(result);

  it("heads the table with both dates and the currency", () => {
    expect(text).toContain("The Halden Group");
    expect(text).toContain("2026-12-31");
    expect(text).toContain("2025-12-31");
    expect(text).toContain("(GBP)");
  });

  it("prints three columns: this period, last period, and the movement", () => {
    const header = text.split("\n").find((l) => l.includes("Account") && l.includes("Movement"));
    expect(header).toBeDefined();
  });

  it("prints a dash where an account has no comparative", () => {
    const line = text.split("\n").find((l) => l.startsWith("1195"));
    expect(line).toContain("—");
  });

  it("says nothing about balance when everything balances", () => {
    expect(text).not.toContain("does not balance");
  });

  it("says so when something does not", () => {
    const bent = { ...result, sound: false };
    expect(renderComparative(bent as typeof result)).toContain("does not balance");
  });
});

describe("the rate table for the comparative period", () => {
  it("defaults to this period's, because one table normally covers both", () => {
    const result = consolidateComparative(demo.groupStructure(), demo.groupLedgers(), {
      current: { ...shared(), asAt: demo.GROUP_AS_AT, period: demo.groupPeriod() },
      prior: {
        asAt: demo.GROUP_PRIOR_AS_AT,
        period: demo.groupPriorPeriod(),
        intercompany: demo.groupIntercompany(),
        acquisitions: demo.groupAcquisitions(),
      },
    });
    expect(result.sound).toBe(true);
    expect(result.prior.translationReserve.toDecimalString()).toBe("-10750.00");
  });

  it("carries the money type through every column", () => {
    const result = comparative();
    const total = result.rows.reduce((running, r) => running.plus(r.current), Money.zero(GBP));
    expect(total.isZero).toBe(true);
  });
});
