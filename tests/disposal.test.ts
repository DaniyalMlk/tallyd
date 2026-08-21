import { describe, expect, it } from "vitest";
import { EUR, GBP } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { JournalEntry } from "../src/ledger/entry.js";
import { Ledger } from "../src/ledger/ledger.js";
import { RateTable } from "../src/fx/table.js";
import { groupChart } from "../src/group/accounts.js";
import { GroupStructure } from "../src/group/structure.js";
import { acquisitionOf } from "../src/group/acquisition.js";
import type { Acquisition } from "../src/group/acquisition.js";
import { disposalOf, disposals, renderDisposal } from "../src/group/disposal.js";
import type { DisposalOptions } from "../src/group/disposal.js";

/**
 * One subsidiary, held 80%, with round numbers throughout.
 *
 *   at acquisition (2024-12-31)  net assets 350,000, paid 400,000
 *                               NCI proportionate  20% x 350,000 =  70,000
 *                               goodwill  400,000 + 70,000 - 350,000 = 120,000
 *   at disposal    (2026-09-30)  net assets 500,000
 *                               NCI  20% x 500,000 = 100,000
 *                               carrying amount  500,000 - 100,000 + 120,000 = 520,000
 */

const chart = groupChart("GBP");

function leg(
  id: string,
  date: string,
  debit: string,
  credit: string,
  amount: string,
): JournalEntry {
  return JournalEntry.simple(
    { id, date, narration: id, debit, credit, amount: Money.parse(amount, GBP) },
    chart,
  );
}

function subsidiaryLedger(): Ledger {
  return Ledger.from(
    [
      leg("S-01", "2023-01-01", "1110", "3100", "300000.00"),
      leg("S-02", "2024-06-30", "1110", "4100", "50000.00"),
      leg("S-03", "2024-12-31", "4100", "3200", "50000.00"),
      // Net assets at 2024-12-31: 350,000.
      leg("S-04", "2025-06-30", "1110", "4100", "50000.00"),
      leg("S-05", "2025-12-31", "4100", "3200", "50000.00"),
      // Net assets at 2025-12-31: 400,000.
      leg("S-06", "2026-05-31", "1110", "4100", "100000.00"),
      // Net assets at 2026-09-30: 500,000.
      leg("S-07", "2026-11-30", "1110", "4100", "90000.00"),
    ],
    chart,
  );
}

function structure(holding = "80"): GroupStructure {
  return GroupStructure.build(
    [
      { code: "P", name: "Parent", currency: GBP },
      {
        code: "S",
        name: "Sub",
        currency: GBP,
        parent: "P",
        holding,
        acquired: "2024-12-31",
        disposed: "2026-09-30",
      },
    ],
    { presentation: "GBP", name: "A group" },
  );
}

const options: DisposalOptions = { rates: RateTable.empty(), presentation: GBP };

function acquisitionFor(group: GroupStructure, ledgers: Record<string, Ledger>): Acquisition {
  return acquisitionOf(
    group,
    ledgers,
    { entity: "S", consideration: Money.parse("400000.00", GBP) },
    { rates: RateTable.empty(), presentation: GBP },
  );
}

function disposalFor(
  overrides: Partial<Parameters<typeof disposalOf>[2]> = {},
  holding = "80",
) {
  const group = structure(holding);
  const ledgers = { P: Ledger.from([], chart), S: subsidiaryLedger() };
  const acquisition = acquisitionFor(group, ledgers);
  return disposalOf(
    group,
    ledgers,
    { entity: "S", proceeds: Money.parse("600000.00", GBP), ...overrides },
    acquisition,
    options,
  );
}

describe("the pieces of a carrying amount", () => {
  const disposal = disposalFor();

  it("reads the net assets on the day control was lost, not at the year end", () => {
    // The subsidiary earns another 90,000 in November, after it has gone.
    expect(disposal.netAssetsAtDisposal).toEqual(Money.parse("500000.00", GBP));
  });

  it("takes the outside stake's claim off, because the group was never selling it", () => {
    expect(disposal.nciAtDisposal).toEqual(Money.parse("100000.00", GBP));
  });

  it("takes off the goodwill that went on when it was bought", () => {
    expect(disposal.goodwillDerecognised).toEqual(Money.parse("120000.00", GBP));
  });

  it("adds up to what the group is giving away", () => {
    expect(disposal.carryingAmount).toEqual(Money.parse("520000.00", GBP));
  });

  it("is net assets less the outside stake plus goodwill, exactly", () => {
    expect(
      disposal.netAssetsAtDisposal.minus(disposal.nciAtDisposal).plus(disposal.goodwillDerecognised),
    ).toEqual(disposal.carryingAmount);
  });

  it("records the day it happened", () => {
    expect(disposal.disposed).toBe("2026-09-30");
  });

  it("says the net assets came from the books rather than from a figure supplied", () => {
    expect(disposal.netAssetsSupplied).toBe(false);
  });
});

describe("the gain, and the loss", () => {
  it("is the proceeds over the carrying amount", () => {
    const disposal = disposalFor();
    expect(disposal.gain).toEqual(Money.parse("80000.00", GBP));
    expect(disposal.loss.isZero).toBe(true);
  });

  it("is a loss and not a negative gain when the proceeds fall short", () => {
    const disposal = disposalFor({ proceeds: Money.parse("450000.00", GBP) });
    expect(disposal.gain.isZero).toBe(true);
    expect(disposal.loss).toEqual(Money.parse("70000.00", GBP));
  });

  it("is nil either way when the price is exactly the carrying amount", () => {
    const disposal = disposalFor({ proceeds: Money.parse("520000.00", GBP) });
    expect(disposal.gain.isZero).toBe(true);
    expect(disposal.loss.isZero).toBe(true);
  });

  it("goes to the income account on a gain and the expense account on a loss", () => {
    expect(disposalFor().account).toBe("4970");
    expect(disposalFor({ proceeds: Money.parse("450000.00", GBP) }).account).toBe("5970");
  });

  it("is not the figure the holder's own books arrive at", () => {
    const disposal = disposalFor();
    // The holder paid 400,000 and received 600,000, so its own books make it
    // 200,000. The group's share of the reserves the company earned in between
    // has already been reported, so the group's gain is smaller.
    expect(disposal.holderResult).toEqual(Money.parse("200000.00", GBP));
    expect(disposal.gain).toEqual(Money.parse("80000.00", GBP));
  });

  it("agrees with the holder when nothing was earned in between", () => {
    // Sold the day after it was bought, at cost: net assets 350,000, NCI
    // 70,000, goodwill 120,000, so a carrying amount of 400,000 — the price.
    const group = GroupStructure.build(
      [
        { code: "P", name: "Parent", currency: GBP },
        {
          code: "S",
          name: "Sub",
          currency: GBP,
          parent: "P",
          holding: "80",
          acquired: "2024-12-31",
          disposed: "2025-01-01",
        },
      ],
      { presentation: "GBP" },
    );
    const ledgers = { P: Ledger.from([], chart), S: subsidiaryLedger() };
    const disposal = disposalOf(
      group,
      ledgers,
      { entity: "S", proceeds: Money.parse("400000.00", GBP) },
      acquisitionFor(group, ledgers),
      options,
    );
    expect(disposal.carryingAmount).toEqual(Money.parse("400000.00", GBP));
    expect(disposal.gain.isZero).toBe(true);
    expect(disposal.holderResult.isZero).toBe(true);
  });
});

describe("a wholly owned subsidiary", () => {
  const disposal = disposalFor({}, "100");

  it("has no outside stake to remove", () => {
    expect(disposal.nciAtDisposal.isZero).toBe(true);
  });

  it("carries the whole net assets plus goodwill", () => {
    // Goodwill on a 100% purchase at 400,000 for net assets of 350,000 is
    // 50,000, so the carrying amount is 500,000 + 50,000.
    expect(disposal.goodwillDerecognised).toEqual(Money.parse("50000.00", GBP));
    expect(disposal.carryingAmount).toEqual(Money.parse("550000.00", GBP));
    expect(disposal.gain).toEqual(Money.parse("50000.00", GBP));
  });

  it("keeps the whole of the company's result for the group", () => {
    expect(disposal.nonControllingInterest.isZero).toBe(true);
    expect(disposal.groupInterest.isWhole).toBe(true);
  });
});

describe("goodwill attributed to the outside stake", () => {
  it("goes out with the stake and not with the group's share", () => {
    const group = structure();
    const ledgers = { P: Ledger.from([], chart), S: subsidiaryLedger() };
    // Fair value: the outside 20% was worth 90,000 rather than its 70,000
    // share of net assets, so 20,000 of the goodwill is theirs.
    const acquisition = acquisitionOf(
      group,
      ledgers,
      {
        entity: "S",
        consideration: Money.parse("400000.00", GBP),
        nciMeasurement: "fair-value",
        nciFairValue: Money.parse("90000.00", GBP),
      },
      { rates: RateTable.empty(), presentation: GBP },
    );
    expect(acquisition.goodwill).toEqual(Money.parse("140000.00", GBP));
    expect(acquisition.nciGoodwill).toEqual(Money.parse("20000.00", GBP));

    const disposal = disposalOf(
      group,
      ledgers,
      { entity: "S", proceeds: Money.parse("600000.00", GBP) },
      acquisition,
      options,
    );
    // The stake's claim is its 100,000 share of net assets plus its 20,000 of
    // goodwill, and the carrying amount is unchanged from the proportionate
    // case: the extra goodwill on the balance sheet is exactly the extra claim.
    expect(disposal.nciAtDisposal).toEqual(Money.parse("120000.00", GBP));
    expect(disposal.carryingAmount).toEqual(Money.parse("520000.00", GBP));
    expect(disposal.gain).toEqual(Money.parse("80000.00", GBP));
  });
});

describe("a figure supplied rather than read", () => {
  it("is used instead of the books and says so", () => {
    const disposal = disposalFor({
      netAssetsAtDisposal: Money.parse("450000.00", GBP),
    });
    expect(disposal.netAssetsSupplied).toBe(true);
    expect(disposal.netAssetsAtDisposal).toEqual(Money.parse("450000.00", GBP));
    expect(disposal.nciAtDisposal).toEqual(Money.parse("90000.00", GBP));
    expect(disposal.carryingAmount).toEqual(Money.parse("480000.00", GBP));
    expect(disposal.gain).toEqual(Money.parse("120000.00", GBP));
  });
});

describe("proceeds in another currency", () => {
  const rates = RateTable.of(
    [{ base: "EUR", quote: "GBP", date: "2026-09-30", rate: "0.80" }],
    { maxStaleDays: 30 },
  );

  it("is translated at the rate on the day control was lost", () => {
    const group = structure();
    const ledgers = { P: Ledger.from([], chart), S: subsidiaryLedger() };
    const disposal = disposalOf(
      group,
      ledgers,
      { entity: "S", proceeds: Money.parse("750000.00", EUR) },
      acquisitionFor(group, ledgers),
      { rates, presentation: GBP },
    );
    expect(disposal.proceeds).toEqual(Money.parse("600000.00", GBP));
    expect(disposal.gain).toEqual(Money.parse("80000.00", GBP));
  });

  it("says which day it wanted a rate for when there is none", () => {
    const group = structure();
    const ledgers = { P: Ledger.from([], chart), S: subsidiaryLedger() };
    expect(() =>
      disposalOf(
        group,
        ledgers,
        { entity: "S", proceeds: Money.parse("750000.00", EUR) },
        acquisitionFor(group, ledgers),
        { rates: RateTable.empty(), presentation: GBP },
      ),
    ).toThrow(/2026-09-30/);
  });
});

describe("what it refuses", () => {
  const group = structure();
  const ledgers = { P: Ledger.from([], chart), S: subsidiaryLedger() };
  const acquisition = acquisitionFor(group, ledgers);

  it("refuses to dispose of the parent company", () => {
    expect(() =>
      disposalOf(
        group,
        ledgers,
        { entity: "P", proceeds: Money.parse("1.00", GBP) },
        acquisition,
        options,
      ),
    ).toThrow(/parent company/);
  });

  it("refuses an acquisition belonging to a different entity", () => {
    const other = GroupStructure.build(
      [
        { code: "P", name: "Parent", currency: GBP },
        { code: "S", name: "Sub", currency: GBP, parent: "P", holding: "80", acquired: "2024-12-31" },
        { code: "T", name: "Other", currency: GBP, parent: "P", holding: "90", acquired: "2024-12-31", disposed: "2026-09-30" },
      ],
      { presentation: "GBP" },
    );
    expect(() =>
      disposalOf(
        other,
        { ...ledgers, T: subsidiaryLedger() },
        { entity: "T", proceeds: Money.parse("1.00", GBP) },
        acquisition,
        options,
      ),
    ).toThrow(/was given the acquisition of S/);
  });

  it("refuses an entity that is held but not controlled", () => {
    const loose = GroupStructure.build(
      [
        { code: "P", name: "Parent", currency: GBP },
        { code: "A", name: "Associate", currency: GBP, parent: "P", holding: "30", disposed: "2026-09-30" },
      ],
      { presentation: "GBP" },
    );
    expect(() =>
      disposalOf(
        loose,
        { P: Ledger.from([], chart), A: subsidiaryLedger() },
        { entity: "A", proceeds: Money.parse("1.00", GBP) },
        { ...acquisition, entity: "A" },
        options,
      ),
    ).toThrow(/not consolidated/);
  });

  it("refuses a disposal with no date anywhere", () => {
    const undated = GroupStructure.build(
      [
        { code: "P", name: "Parent", currency: GBP },
        { code: "S", name: "Sub", currency: GBP, parent: "P", holding: "80", acquired: "2024-12-31" },
      ],
      { presentation: "GBP" },
    );
    expect(() =>
      disposalOf(
        undated,
        ledgers,
        { entity: "S", proceeds: Money.parse("1.00", GBP) },
        acquisition,
        options,
      ),
    ).toThrow(/needs the date control was lost/);
  });

  it("takes a date on the input over the one on the entity", () => {
    const disposal = disposalOf(
      group,
      ledgers,
      { entity: "S", disposed: "2026-05-30", proceeds: Money.parse("600000.00", GBP) },
      acquisition,
      options,
    );
    // The day before the May sale, so the net assets are still 400,000.
    expect(disposal.disposed).toBe("2026-05-30");
    expect(disposal.netAssetsAtDisposal).toEqual(Money.parse("400000.00", GBP));
  });

  it("refuses books it has not been given", () => {
    expect(() =>
      disposalOf(
        group,
        { P: Ledger.from([], chart) },
        { entity: "S", proceeds: Money.parse("1.00", GBP) },
        acquisition,
        options,
      ),
    ).toThrow(/No books for S/);
  });
});

describe("a list of disposals", () => {
  const group = structure();
  const ledgers = { P: Ledger.from([], chart), S: subsidiaryLedger() };
  const acquired = [acquisitionFor(group, ledgers)];

  it("comes back in the structure's order", () => {
    const result = disposals(
      group,
      ledgers,
      [{ entity: "S", proceeds: Money.parse("600000.00", GBP) }],
      acquired,
      options,
    );
    expect(result.map((d) => d.entity)).toEqual(["S"]);
  });

  it("refuses the same entity twice", () => {
    expect(() =>
      disposals(
        group,
        ledgers,
        [
          { entity: "S", proceeds: Money.parse("1.00", GBP) },
          { entity: "S", proceeds: Money.parse("2.00", GBP) },
        ],
        acquired,
        options,
      ),
    ).toThrow(/disposed of twice/);
  });

  it("refuses a company sold but never bought", () => {
    expect(() =>
      disposals(group, ledgers, [{ entity: "S", proceeds: Money.parse("1.00", GBP) }], [], options),
    ).toThrow(/never acquired/);
  });

  it("is empty when nothing was sold", () => {
    expect(disposals(group, ledgers, [], acquired, options)).toEqual([]);
  });
});

describe("rendering", () => {
  it("shows every term of the carrying amount", () => {
    const text = renderDisposal(disposalFor());
    expect(text).toContain("Proceeds");
    expect(text).toContain("600000.00");
    expect(text).toContain("Net assets going with it");
    expect(text).toContain("outside stake's claim");
    expect(text).toContain("Goodwill derecognised");
    expect(text).toContain("Carrying amount");
    expect(text).toContain("Gain on disposal");
  });

  it("names it a loss when it is one", () => {
    const text = renderDisposal(disposalFor({ proceeds: Money.parse("450000.00", GBP) }));
    expect(text).toContain("Loss on disposal");
    expect(text).not.toContain("Gain on disposal");
  });

  it("says when the holder's own books disagree", () => {
    expect(renderDisposal(disposalFor())).toContain("The holder's own books make it 200000.00");
  });

  it("says nothing about the holder when the two agree", () => {
    // They agree only when the carrying amount equals what was paid, which is
    // to say when the company earned nothing the group has already reported.
    const agreeing = disposalFor({
      proceeds: Money.parse("600000.00", GBP),
      netAssetsAtDisposal: Money.parse("350000.00", GBP),
    });
    expect(agreeing.carryingAmount).toEqual(Money.parse("400000.00", GBP));
    expect(agreeing.gain).toEqual(agreeing.holderResult);
    expect(renderDisposal(agreeing)).not.toContain("The holder's own books");
  });
});
