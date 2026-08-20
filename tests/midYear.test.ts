import { describe, expect, it } from "vitest";
import { GBP } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { JournalEntry } from "../src/ledger/entry.js";
import { Ledger } from "../src/ledger/ledger.js";
import { dateRange } from "../src/ledger/date.js";
import { withResultClosed } from "../src/ledger/close.js";
import { trialBalance } from "../src/ledger/trialBalance.js";
import { RateTable } from "../src/fx/table.js";
import { groupChart } from "../src/group/accounts.js";
import { GroupStructure } from "../src/group/structure.js";
import { consolidate } from "../src/group/consolidate.js";
import {
  MID_YEAR_ACQUIRED,
  aldermereLedger,
  consolidateMidYear,
  midYearAcquisitions,
  midYearLedgers,
  midYearPeriod,
  midYearReport,
  midYearStructure,
} from "../src/demo/midYear.js";

const flatRates = () => RateTable.of([], { maxStaleDays: 5000 });

describe("a subsidiary bought a quarter of the way through the year", () => {
  const honest = consolidateMidYear(false);
  const working = honest.workings[0] as NonNullable<(typeof honest.workings)[0]>;

  it("consolidates it, and balances", () => {
    expect(honest.balanced).toBe(true);
    expect(honest.residual.isZero).toBe(true);
    expect(honest.aggregation.entities.map((c) => c.entity)).toEqual(["FG", "AL"]);
  });

  it("takes only the nine months after control changed hands", () => {
    // 300,000 of sales less 180,000 of cost, both dated after 1 April.
    expect(working.profitForPeriod.toDecimalString()).toBe("120000.00");
  });

  it("puts the first quarter's profit where the seller left it", () => {
    const contribution = honest.aggregation.entities.find((c) => c.entity === "AL");
    // 160,000 of sales less 100,000 of cost, both dated before 1 April.
    expect(contribution?.preAcquisitionResult.toDecimalString()).toBe("60000.00");
    expect(contribution?.windowApplied).toBe(true);
    expect(contribution?.control.closeAt).toBe(MID_YEAR_ACQUIRED);
  });

  it("gives the outside stake a share of the post-acquisition result only", () => {
    // 25% of 120,000, not of 180,000.
    expect(working.nciProfitShare.toDecimalString()).toBe("30000.00");
  });

  it("measures goodwill against net assets that include the first quarter", () => {
    // Capital 200,000, reserves 40,000 brought forward, 60,000 earned in the
    // quarter: 300,000 of net assets on the day of the sale. 75% of that is
    // 225,000 and the group paid 260,000.
    expect(working.acquisition.netAssetsAcquired.toDecimalString()).toBe("300000.00");
    expect(working.acquisition.goodwill.toDecimalString()).toBe("35000.00");
  });

  it("shows no reserves earned since control was obtained, because there has not been a year yet", () => {
    expect(working.postAcquisitionReserves.isZero).toBe(true);
  });

  it("carries the outside stake at a quarter of the closing net assets", () => {
    // 200,000 + 40,000 + 60,000 + 120,000 = 420,000, of which 25% is 105,000.
    expect(working.netAssetsNow.toDecimalString()).toBe("420000.00");
    expect(working.nciClosing.toDecimalString()).toBe("105000.00");
  });
});

describe("the same books taking the whole year regardless", () => {
  const honest = consolidateMidYear(false);
  const naive = consolidateMidYear(true);
  const honestWorking = honest.workings[0] as NonNullable<(typeof honest.workings)[0]>;
  const naiveWorking = naive.workings[0] as NonNullable<(typeof naive.workings)[0]>;

  it("balances too, which is the whole problem with it", () => {
    expect(naive.balanced).toBe(true);
    expect(naive.residual.isZero).toBe(true);
  });

  it("reports a result 60,000 larger than the group earned", () => {
    expect(naiveWorking.profitForPeriod.toDecimalString()).toBe("180000.00");
    expect(
      naiveWorking.profitForPeriod.minus(honestWorking.profitForPeriod).toDecimalString(),
    ).toBe("60000.00");
  });

  it("hands the outside stake a share of a profit made before the stake existed", () => {
    expect(naiveWorking.nciProfitShare.toDecimalString()).toBe("45000.00");
    expect(honestWorking.nciProfitShare.toDecimalString()).toBe("30000.00");
  });

  it("shows the symptom: reserves earned backwards since control was obtained", () => {
    expect(naiveWorking.postAcquisitionReserves.toDecimalString()).toBe("-45000.00");
    expect(naiveWorking.postAcquisitionReserves.isNegative).toBe(true);
  });

  it("leaves the closing balance sheet alone: only the split moves", () => {
    expect(naiveWorking.netAssetsNow.equals(honestWorking.netAssetsNow)).toBe(true);
    expect(naiveWorking.nciClosing.equals(honestWorking.nciClosing)).toBe(true);
    expect(naive.goodwill.equals(honest.goodwill)).toBe(true);
  });

  it("does not claim a window it ignored", () => {
    const contribution = naive.aggregation.entities.find((c) => c.entity === "AL");
    expect(contribution?.windowApplied).toBe(false);
    expect(contribution?.preAcquisitionResult.isZero).toBe(true);
  });
});

describe("the property that says the substitution is the right one", () => {
  // Consolidating a company held for the whole period must give the same answer
  // whether or not its books happen to have been closed at the period start.
  // Before this change it did not: unclosed books handed the group every year's
  // profit at once.
  const chart = groupChart("GBP");
  const entry = (id: string, date: string, debit: string, credit: string, amount: string) =>
    JournalEntry.simple(
      { id, date, narration: id, debit, credit, amount: Money.parse(amount, GBP) },
      chart,
    );
  const parent = Ledger.from(
    [
      entry("P1", "2024-12-31", "1110", "3100", "800000.00"),
      entry("P2", "2025-01-02", "1230", "1110", "200000.00"),
      entry("P3", "2026-06-30", "1110", "4200", "150000.00"),
    ],
    chart,
  );
  // Never closed: 2025's and 2026's trading are both still on the income
  // accounts at the 2026 year end.
  const neverClosed = Ledger.from(
    [
      entry("S1", "2024-06-30", "1110", "3100", "150000.00"),
      entry("S2", "2025-05-31", "1110", "4100", "90000.00"),
      entry("S3", "2025-07-31", "5100", "1110", "50000.00"),
      entry("S4", "2026-05-31", "1110", "4100", "140000.00"),
      entry("S5", "2026-07-31", "5100", "1110", "80000.00"),
    ],
    chart,
  );
  const group = GroupStructure.build(
    [
      { code: "P", name: "Parent", currency: GBP },
      { code: "S", name: "Sub", currency: GBP, parent: "P", holding: "80", acquired: "2025-01-02" },
    ],
    { presentation: "GBP", name: "Closed or not" },
  );
  const options = {
    rates: flatRates(),
    asAt: "2026-12-31",
    period: dateRange("2026-01-01", "2026-12-31"),
    acquisitions: [{ entity: "S", consideration: Money.parse("200000.00", GBP) }],
  };

  it("still reads unclosed books as every year at once, which is the gap that remains", () => {
    // The entity was held all period, so no window applies and nothing is
    // closed. 90,000 - 50,000 + 140,000 - 80,000 is taken as 2026's result.
    const result = consolidate(group, { P: parent, S: neverClosed }, options);
    expect(result.workings[0]?.profitForPeriod.toDecimalString()).toBe("100000.00");
  });

  it("gives the right answer once the caller closes them at the period start", () => {
    const closed = withResultClosed(neverClosed, "2025-12-31");
    const result = consolidate(group, { P: parent, S: closed }, options);
    // 140,000 - 80,000: 2026 alone.
    expect(result.workings[0]?.profitForPeriod.toDecimalString()).toBe("60000.00");
  });

  it("reaches the same balance sheet either way, so only the split moves", () => {
    const open = consolidate(group, { P: parent, S: neverClosed }, options);
    const closed = consolidate(
      group,
      { P: parent, S: withResultClosed(neverClosed, "2025-12-31") },
      options,
    );
    expect(open.workings[0]?.netAssetsNow.equals(closed.workings[0]?.netAssetsNow as Money)).toBe(
      true,
    );
    expect(open.nonControllingInterest.equals(closed.nonControllingInterest)).toBe(true);
    expect(open.goodwill.equals(closed.goodwill)).toBe(true);
    expect(open.balanced && closed.balanced).toBe(true);
  });
});

describe("closing does not disturb what it should not", () => {
  it("leaves the entity's trial balance balanced going into the translation", () => {
    const closed = withResultClosed(aldermereLedger(), MID_YEAR_ACQUIRED, {
      id: "PRE-ACQ-AL",
      narration: "pre-acquisition",
    });
    const balances = trialBalance(closed, { currency: GBP, asAt: "2026-12-31" as never });
    expect(balances.balanced).toBe(true);
    expect(balances.difference.isZero).toBe(true);
  });

  it("adds no translation adjustment to a group kept in one currency", () => {
    expect(consolidateMidYear(false).translationReserve.isZero).toBe(true);
  });

  it("leaves the ledgers the caller handed over untouched", () => {
    const ledgers = midYearLedgers();
    const before = (ledgers["AL"] as Ledger).size;
    consolidate(midYearStructure(), ledgers, {
      rates: flatRates(),
      asAt: "2026-12-31",
      period: midYearPeriod(),
      acquisitions: midYearAcquisitions(),
    });
    expect((ledgers["AL"] as Ledger).size).toBe(before);
    expect((ledgers["AL"] as Ledger).has("PRE-ACQ-AL")).toBe(false);
  });
});

describe("a company acquired after the reporting date", () => {
  it("is refused rather than consolidated for a period nobody held it", () => {
    const group = GroupStructure.build(
      [
        { code: "FG", name: "Fenwick Group", currency: GBP },
        { code: "AL", name: "Aldermere Ltd", currency: GBP, parent: "FG", holding: "75", acquired: "2027-04-01" },
      ],
      { presentation: "GBP", name: "The Fenwick Group" },
    );
    expect(() =>
      consolidate(group, midYearLedgers(), {
        rates: flatRates(),
        asAt: "2026-12-31",
        period: midYearPeriod(),
        acquisitions: [{ entity: "AL", consideration: Money.parse("260000.00", GBP) }],
      }),
    ).toThrow(/after the reporting date/);
  });
});

describe("how the mid-year report reads", () => {
  const text = midYearReport();

  it("says which part of the year belonged to the group", () => {
    expect(text).toContain("A company bought a quarter of the way through the year");
    expect(text).toContain("2026-04-02 to 2026-12-31");
    expect(text).toContain("Consolidated from 2026-04-02, not from 2026-01-01");
  });

  it("prints the wrong answer beside the right one", () => {
    expect(text).toContain("And the same books taking the whole year regardless");
    expect(text).toContain("Result the group is entitled to");
    expect(text).toContain("Result taking the whole year");
    expect(text).toContain("Overstated by");
  });

  it("names the only visible symptom of the wrong one", () => {
    expect(text).toContain("earned backwards");
    expect(text).toContain("-45000.00");
  });

  it("says the closing balance sheet is the same either way", () => {
    expect(text).toContain("420000.00 against 420000.00");
  });
});
