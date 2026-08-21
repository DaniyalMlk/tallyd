import { describe, expect, it } from "vitest";
import { EUR, GBP } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { JournalEntry } from "../src/ledger/entry.js";
import { Ledger } from "../src/ledger/ledger.js";
import { dateRange } from "../src/ledger/date.js";
import { RateTable } from "../src/fx/table.js";
import { groupChart, GROUP_ACCOUNTS } from "../src/group/accounts.js";
import { GroupStructure } from "../src/group/structure.js";
import { consolidate, renderConsolidation } from "../src/group/consolidate.js";
import type { Consolidation } from "../src/group/consolidate.js";
import {
  consolidateDisposal,
  disposalAcquisitions,
  disposalDisposals,
  disposalLedgers,
  disposalPeriod,
  disposalStructure,
  DISPOSAL_AS_AT,
} from "../src/demo/disposal.js";

const result = consolidateDisposal();
const gbp = (text: string) => Money.parse(text, GBP);

describe("the consolidated ledger of a group with a disposal in it", () => {
  it("balances", () => {
    expect(result.balanced).toBe(true);
  });

  it("closes the accounting equation to nil", () => {
    expect(result.residual.isZero).toBe(true);
  });

  it("verifies as a ledger in its own right", () => {
    expect(() => result.ledger.verify()).not.toThrow();
    expect(result.ledger.isBalanced).toBe(true);
  });

  it("carries one disposal entry, tagged", () => {
    const entries = result.ledger.all().filter((e) => e.tags.includes("disposal"));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("DISP-PM");
  });

  it("names the company and the date in the narration", () => {
    const entry = result.ledger.all().find((e) => e.id === "DISP-PM");
    expect(entry?.narration).toContain("Pellew Marine");
    expect(entry?.narration).toContain("2026-09-30");
  });
});

describe("what the balance sheet is left carrying", () => {
  it("has none of the company's assets", () => {
    // Only the holder's bank survives: 1,000,000 raised, 400,000 out for the
    // shares, 150,000 and 240,000 of fees in, 160,000 of salaries out, and
    // 600,000 back on the sale.
    expect(result.ledger.balanceOf("1110", GBP)).toEqual(gbp("1430000.00"));
  });

  it("has no goodwill left, because there is nothing for it to attach to", () => {
    expect(result.goodwill.isZero).toBe(true);
  });

  it("has no outside stake left, because their claim went with the company", () => {
    expect(result.nonControllingInterest.isZero).toBe(true);
  });

  it("has nothing left in the investment account", () => {
    expect(result.investmentResidual.isZero).toBe(true);
  });
});

describe("what the income statement keeps", () => {
  it("keeps the company's result for the part of the period it was the group's", () => {
    // 170,000 of charter income less 70,000 of costs, to 30 September. The
    // 90,000 earned in November is not the group's.
    expect(result.ledger.balanceOf("4100", GBP)).toEqual(gbp("-170000.00"));
    expect(result.ledger.balanceOf("5100", GBP)).toEqual(gbp("70000.00"));
  });

  it("still gives the outside stake its share of those eight months", () => {
    expect(result.ledger.balanceOf(GROUP_ACCOUNTS.nciProfitShare, GBP)).toEqual(gbp("20000.00"));
  });

  it("replaces the holder's own gain with the group's", () => {
    expect(result.ledger.balanceOf(GROUP_ACCOUNTS.disposalGain, GBP)).toEqual(gbp("-80000.00"));
  });

  it("reports the whole result as the sum of its three sources", () => {
    // The holder's own trading, the company's eight months, and the gain.
    const own = gbp("240000.00").minus(gbp("160000.00"));
    const subsidiary = gbp("100000.00");
    const gain = gbp("80000.00");
    const income = result.ledger.balanceOf("4100", GBP)
      .plus(result.ledger.balanceOf("4200", GBP))
      .plus(result.ledger.balanceOf(GROUP_ACCOUNTS.disposalGain, GBP));
    const expense = result.ledger.balanceOf("5100", GBP).plus(result.ledger.balanceOf("5200", GBP));
    expect(income.plus(expense).negated()).toEqual(own.plus(subsidiary).plus(gain));
  });
});

describe("the gain is the balancing figure, and it is the right one", () => {
  const working = result.disposals[0];

  it("is there at all", () => {
    expect(result.disposals).toHaveLength(1);
    expect(working?.entity).toBe("PM");
  });

  it("equals proceeds less the carrying amount, exactly", () => {
    expect(working?.result).toEqual(
      working?.disposal.proceeds.minus(working.disposal.carryingAmount),
    );
  });

  it("is the gain the disposal arithmetic arrived at on its own", () => {
    expect(working?.result).toEqual(working?.disposal.gain);
    expect(working?.result).toEqual(gbp("80000.00"));
  });

  it("removes exactly what the aggregation put in", () => {
    expect(working?.netAssetsRemoved).toEqual(gbp("500000.00"));
    expect(working?.nciRemoved).toEqual(gbp("100000.00"));
    expect(working?.goodwillRemoved).toEqual(gbp("120000.00"));
  });

  it("measures the net assets the way the consolidation carries them", () => {
    expect(working?.disposal.netAssetsBasis).toBe("consolidated");
  });

  it("is not the figure the holder's own books arrived at", () => {
    expect(working?.disposal.holderResult).toEqual(gbp("200000.00"));
  });

  it("differs from it by the group's share of what the company retained", () => {
    // 80% of the 150,000 Pellew earned and kept between purchase and sale.
    expect(working?.disposal.holderResult.minus(working.result)).toEqual(gbp("120000.00"));
  });

  it("keeps the company's own result for the period beside the gain", () => {
    expect(working?.resultToDisposal).toEqual(gbp("100000.00"));
  });

  it("totals into the consolidation", () => {
    expect(result.disposalResult).toEqual(gbp("80000.00"));
  });
});

describe("a sale at a loss", () => {
  const atALoss = consolidate(disposalStructure(), disposalLedgers("450000.00"), {
    rates: RateTable.of([], { maxStaleDays: 5000 }),
    asAt: DISPOSAL_AS_AT,
    period: disposalPeriod(),
    acquisitions: disposalAcquisitions(),
    disposals: [{ entity: "PM", proceeds: gbp("450000.00") }],
  });

  it("still balances", () => {
    expect(atALoss.balanced).toBe(true);
    expect(atALoss.residual.isZero).toBe(true);
  });

  it("books the shortfall as an expense and not as negative income", () => {
    expect(atALoss.ledger.balanceOf(GROUP_ACCOUNTS.disposalLoss, GBP)).toEqual(gbp("70000.00"));
    expect(atALoss.ledger.balanceOf(GROUP_ACCOUNTS.disposalGain, GBP).isZero).toBe(true);
  });

  it("reports it as a negative result on the working", () => {
    expect(atALoss.disposals[0]?.result).toEqual(gbp("-70000.00"));
    expect(atALoss.disposalResult).toEqual(gbp("-70000.00"));
  });

  it("says so when it renders", () => {
    expect(renderConsolidation(atALoss)).toContain("Loss on disposal");
  });
});

describe("a sale at exactly the carrying amount", () => {
  const flat = consolidate(disposalStructure(), disposalLedgers("520000.00"), {
    rates: RateTable.of([], { maxStaleDays: 5000 }),
    asAt: DISPOSAL_AS_AT,
    period: disposalPeriod(),
    acquisitions: disposalAcquisitions(),
    disposals: [{ entity: "PM", proceeds: gbp("520000.00") }],
  });

  it("balances with no result at all", () => {
    expect(flat.balanced).toBe(true);
    expect(flat.residual.isZero).toBe(true);
    expect(flat.disposalResult.isZero).toBe(true);
  });

  it("posts nothing to either disposal account", () => {
    expect(flat.ledger.balanceOf(GROUP_ACCOUNTS.disposalGain, GBP).isZero).toBe(true);
    expect(flat.ledger.balanceOf(GROUP_ACCOUNTS.disposalLoss, GBP).isZero).toBe(true);
  });
});

describe("no disposal declared", () => {
  it("leaves the company on the balance sheet at the date it was read", () => {
    // The structure still says it was sold, so its books are still read at
    // September — but with nothing to remove it, its position stays. The
    // consolidation balances and is wrong, and the way it is wrong is that
    // the holder's own gain is still in the result.
    const undeclared = consolidate(disposalStructure(), disposalLedgers(), {
      rates: RateTable.of([], { maxStaleDays: 5000 }),
      asAt: DISPOSAL_AS_AT,
      period: disposalPeriod(),
      acquisitions: disposalAcquisitions(),
    });
    expect(undeclared.balanced).toBe(true);
    expect(undeclared.disposals).toEqual([]);
    expect(undeclared.goodwill).toEqual(gbp("120000.00"));
    expect(undeclared.ledger.balanceOf(GROUP_ACCOUNTS.disposalGain, GBP)).toEqual(
      gbp("-200000.00"),
    );
    // And the investment is credited twice: once by the holder's own sale and
    // once by the elimination, which is the visible symptom.
    expect(undeclared.investmentResidual).toEqual(gbp("-400000.00"));
  });
});

describe("proceeds that disagree with the holder's own books", () => {
  // The books record a sale at 600,000; the consolidation is told 450,000.
  const inconsistent = consolidate(disposalStructure(), disposalLedgers("600000.00"), {
    rates: RateTable.of([], { maxStaleDays: 5000 }),
    asAt: DISPOSAL_AS_AT,
    period: disposalPeriod(),
    acquisitions: disposalAcquisitions(),
    disposals: [{ entity: "PM", proceeds: gbp("450000.00") }],
  });

  it("still balances, because a balanced entry can describe a wrong sale", () => {
    expect(inconsistent.balanced).toBe(true);
    expect(inconsistent.residual.isZero).toBe(true);
  });

  it("leaves the difference in the disposal accounts and says so", () => {
    expect(inconsistent.disposalResidual).toEqual(gbp("150000.00"));
    expect(renderConsolidation(inconsistent)).toContain("Left in the disposal accounts");
  });

  it("is nil when the two agree", () => {
    expect(result.disposalResidual.isZero).toBe(true);
    expect(renderConsolidation(result)).not.toContain("Left in the disposal accounts");
  });

  it("is nil on a group with no disposals at all", () => {
    const none = consolidate(disposalStructure(), disposalLedgers(), {
      rates: RateTable.of([], { maxStaleDays: 5000 }),
      asAt: DISPOSAL_AS_AT,
      period: disposalPeriod(),
      acquisitions: disposalAcquisitions(),
    });
    expect(none.disposalResidual.isZero).toBe(true);
  });
});

describe("a company sold before the period opened", () => {
  const later = consolidate(disposalStructure(), disposalLedgers(), {
    rates: RateTable.of([], { maxStaleDays: 5000 }),
    asAt: "2027-12-31",
    period: dateRange("2027-01-01", "2027-12-31"),
    acquisitions: disposalAcquisitions(),
    disposals: disposalDisposals(),
  });

  it("is not consolidated, and is not an error", () => {
    expect(later.balanced).toBe(true);
    expect(later.residual.isZero).toBe(true);
    expect(later.aggregation.entities.map((c) => c.entity)).toEqual(["HH"]);
  });

  it("says why, beside the associates", () => {
    const excluded = later.aggregation.excluded.find((e) => e.entity === "PM");
    expect(excluded?.reason).toContain("before the period opened");
  });

  it("has no disposal to account for either", () => {
    expect(later.disposals).toEqual([]);
    expect(later.workings.map((w) => w.entity)).toEqual([]);
  });
});

describe("across a currency", () => {
  /**
   * The same shape, with the company sold keeping its books in euro. Rates are
   * chosen so nothing rounds: 1 EUR buys 0.80 GBP throughout.
   */
  const chart = groupChart("GBP");
  const eurChart = groupChart("EUR");

  function ledgerOf(
    legs: readonly [string, string, string, string, string][],
    currency: typeof GBP | typeof EUR,
  ): Ledger {
    const on = currency.code === "GBP" ? chart : eurChart;
    return Ledger.from(
      legs.map(([id, date, debit, credit, amount]) =>
        JournalEntry.simple(
          { id, date, narration: id, debit, credit, amount: Money.parse(amount, currency) },
          on,
        ),
      ),
      on,
    );
  }

  const rates = RateTable.of(
    [
      { base: "EUR", quote: "GBP", date: "2023-01-01", rate: "0.80" },
      { base: "EUR", quote: "GBP", date: "2024-06-30", rate: "0.80" },
      { base: "EUR", quote: "GBP", date: "2024-12-31", rate: "0.80" },
      { base: "EUR", quote: "GBP", date: "2026-01-01", rate: "0.80" },
      { base: "EUR", quote: "GBP", date: "2026-09-30", rate: "0.80" },
      { base: "EUR", quote: "GBP", date: "2026-12-31", rate: "0.80" },
    ],
    { maxStaleDays: 5000 },
  );

  const structure = GroupStructure.build(
    [
      { code: "H", name: "Holder", currency: GBP },
      {
        code: "E",
        name: "Euro Sub",
        currency: EUR,
        parent: "H",
        holding: "80",
        acquired: "2024-12-31",
        disposed: "2026-09-30",
      },
    ],
    { presentation: "GBP", name: "A cross-border group" },
  );

  // Euro sub: capital 250,000 EUR, reserves 187,500 EUR at 1 Jan 2026 (net
  // assets 437,500 EUR = 350,000 GBP), earns 125,000 EUR to September (net
  // assets 562,500 EUR = 450,000 GBP).
  const ledgers = {
    H: ledgerOf(
      [
        ["H-01", "2024-06-30", "1110", "3100", "900000.00"],
        ["H-02", "2024-12-31", "1230", "1110", "300000.00"],
        ["H-03", "2026-09-30", "1110", "1230", "300000.00"],
        ["H-04", "2026-09-30", "1110", "4970", "100000.00"],
      ],
      GBP,
    ),
    E: ledgerOf(
      [
        ["E-01", "2023-01-01", "1110", "3100", "250000.00"],
        ["E-02", "2024-06-30", "1110", "4100", "187500.00"],
        ["E-03", "2024-12-31", "4100", "3200", "187500.00"],
        ["E-04", "2026-05-31", "1110", "4100", "125000.00"],
        ["E-05", "2026-11-30", "1110", "4100", "50000.00"],
      ],
      EUR,
    ),
  };

  const across: Consolidation = consolidate(structure, ledgers, {
    rates,
    asAt: "2026-12-31",
    period: dateRange("2026-01-01", "2026-12-31"),
    acquisitions: [{ entity: "E", consideration: Money.parse("300000.00", GBP) }],
    disposals: [{ entity: "E", proceeds: Money.parse("400000.00", GBP) }],
  });

  it("balances and closes the equation", () => {
    expect(across.balanced).toBe(true);
    expect(across.residual.isZero).toBe(true);
  });

  it("reads the euro balance sheet at the September rate", () => {
    // 562,500 EUR at 0.80 is 450,000 GBP.
    expect(across.disposals[0]?.netAssetsRemoved).toEqual(gbp("450000.00"));
  });

  it("leaves nothing of the euro company behind", () => {
    expect(across.goodwill.isZero).toBe(true);
    expect(across.nonControllingInterest.isZero).toBe(true);
    expect(across.ledger.balanceOf("1110", GBP)).toEqual(gbp("1000000.00"));
  });

  it("makes the gain the group's rather than the holder's", () => {
    // Net assets at acquisition 437,500 EUR at 0.80 = 350,000 GBP; NCI 70,000;
    // goodwill 300,000 + 70,000 - 350,000 = 20,000. Carrying amount at
    // September: 450,000 - 90,000 + 20,000 = 380,000. Gain 400,000 - 380,000.
    expect(across.disposals[0]?.disposal.carryingAmount).toEqual(gbp("380000.00"));
    expect(across.disposalResult).toEqual(gbp("20000.00"));
    expect(across.disposals[0]?.disposal.holderResult).toEqual(gbp("100000.00"));
  });

  it("keeps only the euro company's result to September", () => {
    // 125,000 EUR at the average rate of 0.80 is 100,000 GBP. The 50,000 EUR
    // it earned in November belongs to whoever bought it.
    expect(across.ledger.balanceOf("4100", GBP)).toEqual(gbp("-100000.00"));
  });
});

describe("rendering a disposal", () => {
  const text = renderConsolidation(result);

  it("gives the company its own block", () => {
    expect(text).toContain("PM — Pellew Marine Ltd, disposed of 2026-09-30");
  });

  it("shows every term of the removal", () => {
    expect(text).toContain("Result while it was still the group's");
    expect(text).toContain("Net assets removed");
    expect(text).toContain("outside stake's claim removed with them");
    expect(text).toContain("Goodwill derecognised");
    expect(text).toContain("Gain on disposal");
  });

  it("dates the acquisition working's figures rather than calling them 'now'", () => {
    expect(text).toContain("Net assets at 2026-09-30");
    expect(text).not.toContain("Net assets now");
  });

  it("puts the total in the group's summary", () => {
    expect(text).toContain("Gain on disposals");
  });
});
