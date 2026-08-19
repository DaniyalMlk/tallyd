import { describe, expect, it } from "vitest";
import { JournalEntry } from "../src/ledger/entry.js";
import { Ledger } from "../src/ledger/ledger.js";
import { dateRange } from "../src/ledger/date.js";
import type { ChartOfAccounts } from "../src/accounts/chart.js";
import type { Currency } from "../src/money/currency.js";
import { EUR, GBP } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { RateTable } from "../src/fx/table.js";
import { GroupError, GroupStructure } from "../src/group/structure.js";
import { aggregate } from "../src/group/aggregate.js";
import { groupChart } from "../src/group/accounts.js";
import {
  type IntercompanyDeclaration,
  eliminateIntercompany,
  intercompanyBalances,
  renderEliminations,
} from "../src/group/intercompany.js";

const GBP_CHART = groupChart("GBP");
const EUR_CHART = groupChart("EUR");

/** One rate, quoted every day that matters, so nothing turns on staleness. */
const RATES = RateTable.of(
  [
    { date: "2026-01-01", base: "EUR", quote: "GBP", rate: "0.8000" },
    { date: "2026-06-30", base: "EUR", quote: "GBP", rate: "0.8000" },
    { date: "2026-12-31", base: "EUR", quote: "GBP", rate: "0.8000" },
  ],
  { maxStaleDays: 400 },
);

const PERIOD = dateRange("2026-01-01", "2026-12-31");

const GROUP = GroupStructure.build(
  [
    { code: "P", name: "Parent Ltd", currency: GBP },
    { code: "S", name: "Sub GmbH", currency: EUR, parent: "P", holding: "80" },
  ],
  { presentation: "GBP" },
);

interface Leg {
  id: string;
  date: string;
  narration: string;
  debit: string;
  credit: string;
  amount: string;
}

/** What the postings come to together. Zero in any entry that exists. */
function net(entry: JournalEntry): Money {
  return entry.postings.reduce((running, p) => running.plus(p.amount), Money.zero(GBP));
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

/**
 * The parent lends the subsidiary 40,000 GBP and sells it 10,000 GBP of goods.
 * The subsidiary records both at the 0.80 rate — 50,000 EUR and 12,500 EUR.
 */
function books(options: { transitEur?: string } = {}) {
  const parent = ledgerOf(GBP_CHART, GBP, [
    { id: "P-CAP", date: "2026-01-01", narration: "Capital", debit: "1110", credit: "3100", amount: "200000.00" },
    { id: "P-INV", date: "2026-01-01", narration: "Investment in S", debit: "1230", credit: "1110", amount: "60000.00" },
    { id: "P-LOAN", date: "2026-03-01", narration: "Loan to S", debit: "1190", credit: "1110", amount: "40000.00" },
    { id: "P-SALE", date: "2026-06-30", narration: "Goods to S", debit: "1190", credit: "4950", amount: "10000.00" },
  ]);

  const legs: Leg[] = [
    { id: "S-CAP", date: "2026-01-01", narration: "Capital", debit: "1110", credit: "3100", amount: "75000.00" },
    { id: "S-LOAN", date: "2026-03-01", narration: "Loan from P", debit: "1110", credit: "2190", amount: "50000.00" },
    { id: "S-BUY", date: "2026-06-30", narration: "Goods from P", debit: "5960", credit: "2190", amount: "12500.00" },
  ];
  if (options.transitEur !== undefined) {
    // A repayment the subsidiary posted on the 30th and the parent has not
    // seen: S's payable comes down, P's receivable does not.
    legs.push({
      id: "S-PAY",
      date: "2026-12-30",
      narration: "Repayment to P",
      debit: "2190",
      credit: "1110",
      amount: options.transitEur,
    });
  }
  return { parent, sub: ledgerOf(EUR_CHART, EUR, legs) };
}

const DECLARATIONS: readonly IntercompanyDeclaration[] = [
  { entity: "P", account: "1190", counterparty: "S", note: "loan and trading" },
  { entity: "S", account: "2190", counterparty: "P" },
  { entity: "P", account: "4950", counterparty: "S" },
  { entity: "S", account: "5960", counterparty: "P" },
];

function combined(options: { transitEur?: string } = {}) {
  const { parent, sub } = books(options);
  return aggregate(GROUP, { P: parent, S: sub }, {
    rates: RATES,
    asAt: "2026-12-31",
    period: PERIOD,
    averageMethod: "quoted",
  });
}

describe("two sides that agree eliminate to nothing", () => {
  it("pairs each declaration with its mirror", () => {
    const result = eliminateIntercompany(GROUP, combined(), DECLARATIONS, { chart: GBP_CHART });
    expect(result.pairs).toHaveLength(2);
    expect(result.unmatched).toEqual([]);
    expect(result.pairs.map((p) => p.kind).sort()).toEqual([
      "balance-sheet",
      "profit-and-loss",
    ]);
  });

  it("reads the balances at the figures the aggregation used", () => {
    const sides = intercompanyBalances(GROUP, combined(), DECLARATIONS);
    const loan = sides.find((s) => s.entity === "P" && s.account === "1190");
    // 40,000 lent plus 10,000 of goods.
    expect(loan!.presentation.toDecimalString()).toBe("50000.00");
    const payable = sides.find((s) => s.entity === "S");
    // 62,500 EUR at 0.80 is 50,000 GBP, on the credit side.
    expect(payable!.functional.toDecimalString()).toBe("-62500.00");
    expect(payable!.presentation.toDecimalString()).toBe("-50000.00");
  });

  it("nets the balance sheet pair to nothing", () => {
    const result = eliminateIntercompany(GROUP, combined(), DECLARATIONS, { chart: GBP_CHART });
    const balanceSheet = result.pairs.find((p) => p.kind === "balance-sheet");
    expect(balanceSheet!.difference.isZero).toBe(true);
    expect(balanceSheet!.agrees).toBe(true);
    expect(result.disagreements).toEqual([]);
  });

  it("nets the trading pair to nothing", () => {
    const result = eliminateIntercompany(GROUP, combined(), DECLARATIONS, { chart: GBP_CHART });
    const trading = result.pairs.find((p) => p.kind === "profit-and-loss");
    // Sales of 10,000 against purchases of 12,500 EUR translated at the 0.80
    // average, which is 10,000.
    expect(trading!.sides.map((s) => s.presentation.toDecimalString()).sort()).toEqual([
      "-10000.00",
      "10000.00",
    ]);
    expect(trading!.difference.isZero).toBe(true);
  });

  it("writes one balanced entry per pair, reversing both sides", () => {
    const result = eliminateIntercompany(GROUP, combined(), DECLARATIONS, { chart: GBP_CHART });
    expect(result.entries).toHaveLength(2);
    for (const entry of result.entries) {
      // JournalEntry refuses to exist unbalanced, so this is the invariant
      // holding rather than a check on the arithmetic here.
      expect(net(entry).isZero).toBe(true);
      expect(entry.postings).toHaveLength(2);
      expect(entry.tags).toContain("intercompany");
      expect(entry.date).toBe("2026-12-31");
    }
    const loanEntry = result.entries.find((e) => e.touches("1190"));
    expect(loanEntry!.amountFor("1190").toDecimalString()).toBe("-50000.00");
    expect(loanEntry!.amountFor("2190").toDecimalString()).toBe("50000.00");
  });

  it("leaves the combined trial balance balanced after the entries are applied", () => {
    const aggregation = combined();
    const result = eliminateIntercompany(GROUP, aggregation, DECLARATIONS, { chart: GBP_CHART });
    const movement = result.entries
      .flatMap((e) => e.postings)
      .reduce((running, p) => running.plus(p.amount), Money.zero(GBP));
    expect(movement.isZero).toBe(true);
    expect(aggregation.balanced).toBe(true);
  });

  it("reports what it removed, measured once and not twice", () => {
    const result = eliminateIntercompany(GROUP, combined(), DECLARATIONS, { chart: GBP_CHART });
    // 50,000 of receivable and 10,000 of purchases are the debit sides.
    expect(result.totalEliminated.toDecimalString()).toBe("60000.00");
    expect(result.totalDifference.isZero).toBe(true);
  });
});

describe("two sides that disagree leave a difference with a name", () => {
  it("carries the residual rather than plugging it", () => {
    // S repays 6,250 EUR (5,000 GBP) on 30 December; P has not seen it.
    const result = eliminateIntercompany(GROUP, combined({ transitEur: "6250.00" }), DECLARATIONS, {
      chart: GBP_CHART,
    });
    const pair = result.pairs.find((p) => p.kind === "balance-sheet");
    expect(pair!.agrees).toBe(false);
    expect(pair!.difference.toDecimalString()).toBe("5000.00");
    expect(result.disagreements).toHaveLength(1);
  });

  it("books the difference to items in transit, keeping the entry balanced", () => {
    const result = eliminateIntercompany(GROUP, combined({ transitEur: "6250.00" }), DECLARATIONS, {
      chart: GBP_CHART,
    });
    const entry = result.entries.find((e) => e.touches("1190")) as JournalEntry;
    expect(entry.postings).toHaveLength(3);
    expect(entry.amountFor("1195").toDecimalString()).toBe("5000.00");
    expect(net(entry).isZero).toBe(true);
  });

  it("sends the difference wherever it is told to", () => {
    const result = eliminateIntercompany(GROUP, combined({ transitEur: "6250.00" }), DECLARATIONS, {
      chart: GBP_CHART,
      differenceAccount: "1140",
    });
    const entry = result.entries.find((e) => e.touches("1190")) as JournalEntry;
    expect(entry.amountFor("1140").toDecimalString()).toBe("5000.00");
  });

  it("treats a difference inside the tolerance as agreement without hiding it", () => {
    const result = eliminateIntercompany(GROUP, combined({ transitEur: "6250.00" }), DECLARATIONS, {
      chart: GBP_CHART,
      tolerance: Money.parse("5000.00", GBP),
    });
    const pair = result.pairs.find((p) => p.kind === "balance-sheet");
    expect(pair!.agrees).toBe(true);
    expect(pair!.difference.toDecimalString()).toBe("5000.00");
    const entry = result.entries.find((e) => e.touches("1190")) as JournalEntry;
    expect(entry.amountFor("1195").toDecimalString()).toBe("5000.00");
  });

  it("names the larger side when it renders the disagreement", () => {
    const text = renderEliminations(
      eliminateIntercompany(GROUP, combined({ transitEur: "6250.00" }), DECLARATIONS, {
        chart: GBP_CHART,
      }),
    );
    expect(text).toContain("out by 5000.00 — P's side is the larger");
    expect(text).toContain("rather than plugged");
  });
});

describe("a declaration with no mirror is a finding, not an elimination", () => {
  const oneSided: readonly IntercompanyDeclaration[] = [
    { entity: "P", account: "1190", counterparty: "S" },
  ];

  it("reports the unpaired side and writes no entry for it", () => {
    const result = eliminateIntercompany(GROUP, combined(), oneSided, { chart: GBP_CHART });
    expect(result.pairs).toEqual([]);
    expect(result.entries).toEqual([]);
    expect(result.unmatched).toHaveLength(1);
    expect(result.unmatched[0]?.reason).toBe(
      'S declares no "balance-sheet" account facing P',
    );
    expect(result.unmatched[0]?.side.presentation.toDecimalString()).toBe("50000.00");
  });

  it("does not count an unpaired side as eliminated", () => {
    const result = eliminateIntercompany(GROUP, combined(), oneSided, { chart: GBP_CHART });
    expect(result.totalEliminated.isZero).toBe(true);
  });

  it("refuses two accounts on one relationship rather than pairing the wrong ones", () => {
    expect(() =>
      eliminateIntercompany(
        GROUP,
        combined(),
        [
          { entity: "P", account: "1190", counterparty: "S" },
          { entity: "S", account: "2190", counterparty: "P" },
          { entity: "P", account: "1195", counterparty: "S" },
        ],
        { chart: GBP_CHART },
      ),
    ).toThrow(/two accounts facing S on the same "balance-sheet" relationship/);
  });

  it("pairs two relationships between the same companies once they are named", () => {
    const result = eliminateIntercompany(
      GROUP,
      combined(),
      [
        { entity: "P", account: "1190", counterparty: "S", link: "loan" },
        { entity: "S", account: "2190", counterparty: "P", link: "loan" },
        { entity: "P", account: "1195", counterparty: "S", link: "transit" },
        { entity: "S", account: "1195", counterparty: "P", link: "transit" },
      ],
      { chart: GBP_CHART },
    );
    expect(result.pairs).toHaveLength(2);
    expect(result.unmatched).toEqual([]);
  });

  it("renders the unpaired side so it cannot be missed", () => {
    const text = renderEliminations(
      eliminateIntercompany(GROUP, combined(), oneSided, { chart: GBP_CHART }),
    );
    expect(text).toContain("UNPAIRED P 1190");
  });
});

describe("what a declaration may not say", () => {
  it("refuses an entity as its own counterparty", () => {
    expect(() =>
      intercompanyBalances(GROUP, combined(), [
        { entity: "P", account: "1190", counterparty: "P" },
      ]),
    ).toThrow(/cannot be its own counterparty/);
  });

  it("refuses an entity outside the group", () => {
    expect(() =>
      intercompanyBalances(GROUP, combined(), [
        { entity: "X", account: "1190", counterparty: "S" },
      ]),
    ).toThrow(GroupError);
    expect(() =>
      intercompanyBalances(GROUP, combined(), [
        { entity: "P", account: "1190", counterparty: "X" },
      ]),
    ).toThrow(/not in the group/);
  });

  it("refuses one account declared against two counterparties", () => {
    const group = GroupStructure.build([
      { code: "P", name: "P", currency: GBP },
      { code: "S", name: "S", currency: EUR, parent: "P", holding: "80" },
      { code: "T", name: "T", currency: GBP, parent: "P", holding: "100" },
    ]);
    const { parent, sub } = books();
    const aggregation = aggregate(group, { P: parent, S: sub, T: parent }, {
      rates: RATES,
      asAt: "2026-12-31",
      period: PERIOD,
      averageMethod: "quoted",
    });
    expect(() =>
      intercompanyBalances(group, aggregation, [
        { entity: "P", account: "1190", counterparty: "S" },
        { entity: "P", account: "1190", counterparty: "T" },
      ]),
    ).toThrow(/declared intercompany twice/);
  });

  it("skips a declaration against an entity that is not being consolidated", () => {
    const group = GroupStructure.build([
      { code: "P", name: "P", currency: GBP },
      { code: "A", name: "Associate", currency: GBP, parent: "P", holding: "30" },
    ]);
    const { parent } = books();
    const aggregation = aggregate(group, { P: parent }, {
      rates: RATES,
      asAt: "2026-12-31",
      period: PERIOD,
    });
    const sides = intercompanyBalances(group, aggregation, [
      { entity: "A", account: "2190", counterparty: "P" },
      { entity: "P", account: "1190", counterparty: "A" },
    ]);
    expect(sides.map((s) => s.entity)).toEqual(["P"]);
  });

  it("treats an account with no balance as nothing rather than as missing", () => {
    const sides = intercompanyBalances(GROUP, combined(), [
      { entity: "P", account: "2190", counterparty: "S" },
    ]);
    expect(sides[0]?.presentation.isZero).toBe(true);
    const result = eliminateIntercompany(
      GROUP,
      combined(),
      [
        { entity: "P", account: "2190", counterparty: "S" },
        { entity: "S", account: "1190", counterparty: "P" },
      ],
      { chart: GBP_CHART },
    );
    expect(result.pairs).toHaveLength(1);
    expect(result.entries).toEqual([]);
  });
});

describe("rendering", () => {
  it("summarises the pairs and what was removed", () => {
    const text = renderEliminations(
      eliminateIntercompany(GROUP, combined(), DECLARATIONS, { chart: GBP_CHART }),
    );
    expect(text).toContain("Intercompany eliminations — 2 pairs");
    expect(text).toContain("60000.00 GBP removed");
    expect(text).toContain("agrees");
  });
});
