import { describe, expect, it } from "vitest";
import { JournalEntry } from "../src/ledger/entry.js";
import { Ledger } from "../src/ledger/ledger.js";
import { dateRange } from "../src/ledger/date.js";
import { standardChart } from "../src/accounts/standard.js";
import { ChartOfAccounts } from "../src/accounts/chart.js";
import type { Currency } from "../src/money/currency.js";
import { EUR, GBP, USD } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { RateTable } from "../src/fx/table.js";
import { GroupError, GroupStructure } from "../src/group/structure.js";
import { aggregate, contribution, renderAggregation } from "../src/group/aggregate.js";

const GBP_CHART = standardChart("GBP");
const EUR_CHART = standardChart("EUR");
const USD_CHART = standardChart("USD");

const RATES = RateTable.of(
  [
    { date: "2025-01-01", base: "EUR", quote: "GBP", rate: "0.8000" },
    { date: "2026-01-01", base: "EUR", quote: "GBP", rate: "0.8500" },
    { date: "2026-06-30", base: "EUR", quote: "GBP", rate: "0.8600" },
    { date: "2026-12-31", base: "EUR", quote: "GBP", rate: "0.9000" },
    { date: "2025-01-01", base: "USD", quote: "GBP", rate: "0.7500" },
    { date: "2026-01-01", base: "USD", quote: "GBP", rate: "0.7600" },
    { date: "2026-06-30", base: "USD", quote: "GBP", rate: "0.7800" },
    { date: "2026-12-31", base: "USD", quote: "GBP", rate: "0.8000" },
  ],
  { maxStaleDays: 400 },
);

const PERIOD = dateRange("2026-01-01", "2026-12-31");

interface BookInput {
  chart: ChartOfAccounts;
  currency: Currency;
  prefix: string;
  capital: string;
  sale: string;
  cost: string;
}

/** Capital subscribed in 2025, one sale and one cost mid-2026. */
function books(input: BookInput): Ledger {
  const { chart, currency, prefix } = input;
  return Ledger.from(
    [
      JournalEntry.simple(
        {
          id: `${prefix}-CAP`,
          date: "2025-01-01",
          narration: "Share capital",
          debit: "1110",
          credit: "3100",
          amount: Money.parse(input.capital, currency),
        },
        chart,
      ),
      JournalEntry.simple(
        {
          id: `${prefix}-SALE`,
          date: "2026-06-30",
          narration: "Sales",
          debit: "1110",
          credit: "4100",
          amount: Money.parse(input.sale, currency),
        },
        chart,
      ),
      JournalEntry.simple(
        {
          id: `${prefix}-COST`,
          date: "2026-06-30",
          narration: "Cost of sales",
          debit: "5100",
          credit: "1110",
          amount: Money.parse(input.cost, currency),
        },
        chart,
      ),
    ],
    chart,
  );
}

const PARENT = books({
  chart: GBP_CHART,
  currency: GBP,
  prefix: "P",
  capital: "100000.00",
  sale: "50000.00",
  cost: "20000.00",
});

const GERMAN = books({
  chart: EUR_CHART,
  currency: EUR,
  prefix: "S",
  capital: "50000.00",
  sale: "30000.00",
  cost: "12000.00",
});

const AMERICAN = books({
  chart: USD_CHART,
  currency: USD,
  prefix: "T",
  capital: "20000.00",
  sale: "16000.00",
  cost: "6000.00",
});

const GROUP = GroupStructure.build(
  [
    { code: "P", name: "Parent Ltd", currency: GBP },
    { code: "S", name: "Sub GmbH", currency: EUR, parent: "P", holding: "80" },
    { code: "T", name: "Third Inc", currency: USD, parent: "S", holding: "75" },
  ],
  { presentation: "GBP", name: "The Group" },
);

const LEDGERS = new Map([
  ["P", PARENT],
  ["S", GERMAN],
  ["T", AMERICAN],
]);

function run(overrides: Partial<Parameters<typeof aggregate>[2]> = {}) {
  return aggregate(GROUP, LEDGERS, {
    rates: RATES,
    asAt: "2026-12-31",
    period: PERIOD,
    averageMethod: "quoted",
    ...overrides,
  });
}

describe("every controlled entity goes in, in full", () => {
  it("adds all three sets of books", () => {
    const result = run();
    expect(result.entities.map((e) => e.entity)).toEqual(["P", "S", "T"]);
    expect(result.excluded).toEqual([]);
  });

  it("adds a subsidiary's whole balance sheet and not the group's share of it", () => {
    const result = run();
    const cash = result.rows.find((r) => r.account === "1110");
    // The German company holds 50,000 + 30,000 - 12,000 = 68,000 EUR of cash,
    // at the closing rate of 0.90: 61,200 GBP. All of it, though 20% of the
    // company belongs to somebody else.
    expect(contribution(cash!, "S").toDecimalString()).toBe("61200.00");
  });

  it("keeps each entity's contribution to each line", () => {
    const result = run();
    const sales = result.rows.find((r) => r.account === "4100");
    expect([...sales!.byEntity.keys()].sort()).toEqual(["P", "S", "T"]);
    // Income takes the average rate. Quoted average EUR/GBP over 2026 is the
    // mean of 0.85, 0.86 and 0.90 = 0.87. 30,000 x 0.87 = 26,100.
    expect(contribution(sales!, "S").toDecimalString()).toBe("-26100.00");
    // USD 0.76, 0.78, 0.80 averages 0.78. 16,000 x 0.78 = 12,480.
    expect(contribution(sales!, "T").toDecimalString()).toBe("-12480.00");
    expect(contribution(sales!, "P").toDecimalString()).toBe("-50000.00");
    expect(sales!.total.toDecimalString()).toBe("-88580.00");
  });

  it("translates equity at the rate on the day it was subscribed", () => {
    const result = run();
    const capital = result.rows.find((r) => r.account === "3100");
    // EUR 50,000 subscribed on 2025-01-01 at 0.80 is 40,000 GBP, and stays so.
    expect(contribution(capital!, "S").toDecimalString()).toBe("-40000.00");
    // USD 20,000 at 0.75 is 15,000 GBP.
    expect(contribution(capital!, "T").toDecimalString()).toBe("-15000.00");
  });

  it("reports zero for an entity that did not touch a line", () => {
    const result = run();
    const row = result.rows.find((r) => r.account === "1110");
    expect(contribution(row!, "Z").isZero).toBe(true);
  });
});

describe("the combined trial balance still balances", () => {
  it("balances once the translation reserve is counted", () => {
    const result = run();
    expect(result.balanced).toBe(true);
    expect(result.totalDebit.equals(result.totalCredit)).toBe(true);
  });

  it("does not balance on the untranslated rows alone", () => {
    const result = run();
    const net = result.rows.reduce(
      (running, row) => running.plus(row.total),
      Money.zero(result.presentation),
    );
    expect(net.isZero).toBe(false);
    expect(net.negated().equals(result.translationAdjustment)).toBe(true);
  });

  it("carries the reserve per entity as well as in total", () => {
    const result = run();
    const summed = result.entities.reduce(
      (running, c) => running.plus(c.translationAdjustment),
      Money.zero(result.presentation),
    );
    expect(summed.equals(result.translationAdjustment)).toBe(true);
    // The parent keeps its books in the presentation currency, so it
    // contributes nothing to the reserve.
    const parent = result.entities.find((c) => c.entity === "P");
    expect(parent!.translationAdjustment.isZero).toBe(true);
    expect(parent!.translation.rows.every((r) => r.basis === "none")).toBe(true);
  });

  it("has nothing to translate when every entity keeps one currency", () => {
    const group = GroupStructure.build([
      { code: "P", name: "Parent", currency: GBP },
      { code: "S", name: "Sub", currency: GBP, parent: "P", holding: "80" },
    ]);
    const result = aggregate(
      group,
      new Map([
        ["P", PARENT],
        [
          "S",
          books({
            chart: GBP_CHART,
            currency: GBP,
            prefix: "S2",
            capital: "10.00",
            sale: "5.00",
            cost: "1.00",
          }),
        ],
      ]),
      { rates: RateTable.empty(), asAt: "2026-12-31", period: PERIOD },
    );
    expect(result.translationAdjustment.isZero).toBe(true);
    expect(result.balanced).toBe(true);
  });

  it("adds up in the presentation currency and not in any entity's own", () => {
    const result = run();
    expect(result.presentation.code).toBe("GBP");
    expect(result.rows.every((r) => r.total.currency.code === "GBP")).toBe(true);
  });
});

describe("what aggregation refuses and what it reports", () => {
  it("refuses to consolidate with a controlled entity's books missing", () => {
    expect(() =>
      aggregate(GROUP, new Map([["P", PARENT]]), {
        rates: RATES,
        asAt: "2026-12-31",
        period: PERIOD,
      }),
    ).toThrow(GroupError);
    expect(() =>
      aggregate(GROUP, new Map([["P", PARENT]]), {
        rates: RATES,
        asAt: "2026-12-31",
        period: PERIOD,
      }),
    ).toThrow(/No books for S, T/);
  });

  it("does not need books for an entity it is not consolidating", () => {
    const group = GroupStructure.build([
      { code: "P", name: "Parent", currency: GBP },
      { code: "A", name: "Associate", currency: EUR, parent: "P", holding: "30" },
    ]);
    const result = aggregate(group, { P: PARENT }, {
      rates: RATES,
      asAt: "2026-12-31",
      period: PERIOD,
    });
    expect(result.entities.map((e) => e.entity)).toEqual(["P"]);
    expect(result.excluded).toEqual([
      { entity: "A", reason: "held 30% and not controlled" },
    ]);
  });

  it("says why an entity was left out when a definition denied control", () => {
    const group = GroupStructure.build([
      { code: "P", name: "Parent", currency: GBP },
      { code: "J", name: "Joint venture", currency: GBP, parent: "P", holding: "60", controlled: false },
    ]);
    const result = aggregate(group, { P: PARENT }, {
      rates: RATES,
      asAt: "2026-12-31",
      period: PERIOD,
    });
    expect(result.excluded[0]?.reason).toMatch(/denied by the group's own definition/);
  });

  it("reports a code that means different things in different books", () => {
    const oddChart = ChartOfAccounts.build(
      GBP_CHART.toDefinitions().map((d) =>
        d.code === "4100" ? { ...d, name: "Turnover" } : d,
      ),
      { currency: "GBP" },
    );
    const group = GroupStructure.build([
      { code: "P", name: "Parent", currency: GBP },
      { code: "S", name: "Sub", currency: GBP, parent: "P", holding: "80" },
    ]);
    const result = aggregate(
      group,
      {
        P: PARENT,
        S: books({
          chart: oddChart,
          currency: GBP,
          prefix: "S3",
          capital: "10.00",
          sale: "5.00",
          cost: "1.00",
        }),
      },
      { rates: RateTable.empty(), asAt: "2026-12-31", period: PERIOD },
    );
    const conflict = result.nameConflicts.find((c) => c.account === "4100");
    expect(conflict).toBeDefined();
    expect(conflict!.names.map((n) => n.name).sort()).toEqual(["Sales", "Turnover"]);
  });

  it("takes ledgers as a plain object as well as a map", () => {
    const fromObject = aggregate(GROUP, { P: PARENT, S: GERMAN, T: AMERICAN }, {
      rates: RATES,
      asAt: "2026-12-31",
      period: PERIOD,
      averageMethod: "quoted",
    });
    expect(fromObject.rows.map((r) => r.total.toDecimalString())).toEqual(
      run().rows.map((r) => r.total.toDecimalString()),
    );
  });
});

describe("rendering", () => {
  it("shows a column per entity and a combined column", () => {
    const text = renderAggregation(run());
    expect(text).toContain("Combined trial balance as at 2026-12-31 (GBP), 3 entities");
    expect(text).toContain("Translation reserve");
    expect(text).toContain("Nothing is eliminated here");
  });

  it("says which entities were not consolidated", () => {
    const group = GroupStructure.build([
      { code: "P", name: "Parent", currency: GBP },
      { code: "A", name: "Associate", currency: EUR, parent: "P", holding: "30" },
    ]);
    const text = renderAggregation(
      aggregate(group, { P: PARENT }, { rates: RATES, asAt: "2026-12-31", period: PERIOD }),
    );
    expect(text).toContain("Not consolidated: A");
  });
});
