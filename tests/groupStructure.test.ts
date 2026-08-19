import { describe, expect, it } from "vitest";
import {
  type EntityDefinition,
  GroupError,
  GroupStructure,
  UnknownEntityError,
} from "../src/group/structure.js";
import { Interest } from "../src/group/interest.js";
import { EUR, GBP, USD } from "../src/money/currency.js";

/** Parent in London, 80% of a German company, which holds 75% of a US one. */
const CHAIN: readonly EntityDefinition[] = [
  { code: "P", name: "Parent Ltd", currency: GBP },
  { code: "S", name: "Sub GmbH", currency: EUR, parent: "P", holding: "80", acquired: "2024-01-01" },
  { code: "T", name: "Third Inc", currency: USD, parent: "S", holding: "75", acquired: "2025-07-01" },
];

describe("a group has one company at the top", () => {
  it("finds the parent as the entity nobody holds", () => {
    const group = GroupStructure.build(CHAIN);
    expect(group.parent).toBe("P");
    expect(group.parentEntity().name).toBe("Parent Ltd");
    expect(group.size).toBe(3);
  });

  it("refuses a group with two entities held by nobody", () => {
    expect(() =>
      GroupStructure.build([
        { code: "A", name: "A", currency: GBP },
        { code: "B", name: "B", currency: GBP },
      ]),
    ).toThrow(/one parent company/);
  });

  it("refuses an empty group", () => {
    expect(() => GroupStructure.build([])).toThrow(GroupError);
  });

  it("takes the presentation currency from the parent unless told otherwise", () => {
    expect(GroupStructure.build(CHAIN).presentation.code).toBe("GBP");
    expect(GroupStructure.build(CHAIN, { presentation: "USD" }).presentation.code).toBe("USD");
  });

  it("orders entities so a holder always comes before what it holds", () => {
    const group = GroupStructure.build([...CHAIN].reverse());
    expect(group.order).toEqual(["P", "S", "T"]);
  });
});

describe("effective interest is the sum over every path", () => {
  it("multiplies down a chain exactly", () => {
    const group = GroupStructure.build(CHAIN);
    expect(group.effectiveInterest("S").toPercentString()).toBe("80%");
    expect(group.effectiveInterest("T").toPercentString()).toBe("60%");
    expect(group.nonControllingInterest("T").toPercentString()).toBe("40%");
  });

  it("adds a direct holding to one held through a subsidiary", () => {
    // P holds 20% of T directly and 80% of S, which holds 60% of T.
    // 20% + 80% x 60% = 68%.
    const group = GroupStructure.build([
      { code: "P", name: "Parent", currency: GBP },
      { code: "S", name: "Sub", currency: GBP, parent: "P", holding: "80" },
      {
        code: "T",
        name: "Third",
        currency: GBP,
        heldBy: [
          { holder: "P", interest: "20" },
          { holder: "S", interest: "60" },
        ],
      },
    ]);
    expect(group.effectiveInterest("T").toPercentString()).toBe("68%");
    expect(group.nonControllingInterest("T").toPercentString()).toBe("32%");
  });

  it("controls a company held 20% directly and 60% through a subsidiary", () => {
    const group = GroupStructure.build([
      { code: "P", name: "Parent", currency: GBP },
      { code: "S", name: "Sub", currency: GBP, parent: "P", holding: "80" },
      {
        code: "T",
        name: "Third",
        currency: GBP,
        heldBy: [
          { holder: "P", interest: "20" },
          { holder: "S", interest: "60" },
        ],
      },
    ]);
    expect(group.isControlled("T")).toBe(true);
  });

  it("keeps a third exact rather than rounding it into the money", () => {
    const group = GroupStructure.build([
      { code: "P", name: "Parent", currency: GBP },
      { code: "S", name: "Sub", currency: GBP, parent: "P", holding: "2/3" },
    ]);
    expect(group.effectiveInterest("S").toRatioString()).toBe("2/3");
    expect(group.nonControllingInterest("S").toRatioString()).toBe("1/3");
  });

  it("gives the parent the whole of itself", () => {
    const group = GroupStructure.build(CHAIN);
    expect(group.parentEntity().effective.isWhole).toBe(true);
    expect(group.parentEntity().nonControlling.isZero).toBe(true);
  });

  it("defaults an undeclared holding to the whole company", () => {
    const group = GroupStructure.build([
      { code: "P", name: "Parent", currency: GBP },
      { code: "S", name: "Sub", currency: GBP, parent: "P" },
    ]);
    expect(group.effectiveInterest("S").isWhole).toBe(true);
    expect(group.withNonControllingInterest()).toHaveLength(0);
  });
});

describe("control is decided separately from ownership", () => {
  it("consolidates a company it controls but owns a minority of", () => {
    const group = GroupStructure.build(CHAIN);
    const third = group.get("T");
    expect(third.controlled).toBe(true);
    expect(third.effective.compare(Interest.of(1n, 2n))).toBe(1);
    expect(group.consolidated().map((e) => e.code)).toEqual(["P", "S", "T"]);
  });

  it("leaves an entity out of the consolidation when the chain breaks", () => {
    // P holds 80% of S; S holds 40% of T. T is an associate, not a subsidiary.
    const group = GroupStructure.build([
      { code: "P", name: "Parent", currency: GBP },
      { code: "S", name: "Sub", currency: GBP, parent: "P", holding: "80" },
      { code: "T", name: "Associate", currency: GBP, parent: "S", holding: "40" },
    ]);
    expect(group.isControlled("T")).toBe(false);
    expect(group.consolidated().map((e) => e.code)).toEqual(["P", "S"]);
    expect(group.associates().map((e) => e.code)).toEqual(["T"]);
    expect(group.effectiveInterest("T").toPercentString()).toBe("32%");
  });

  it("does not carry control through a company it does not control", () => {
    // P holds 40% of A; A holds 90% of B. P controls neither.
    const group = GroupStructure.build([
      { code: "P", name: "Parent", currency: GBP },
      { code: "A", name: "Associate", currency: GBP, parent: "P", holding: "40" },
      { code: "B", name: "Its subsidiary", currency: GBP, parent: "A", holding: "90" },
    ]);
    expect(group.isControlled("A")).toBe(false);
    expect(group.isControlled("B")).toBe(false);
    expect(group.effectiveInterest("B").toPercentString()).toBe("36%");
  });

  it("lets a definition assert control a majority would not give", () => {
    const group = GroupStructure.build([
      { code: "P", name: "Parent", currency: GBP },
      { code: "S", name: "Sub", currency: GBP, parent: "P", holding: "45", controlled: true },
    ]);
    expect(group.isControlled("S")).toBe(true);
    expect(group.get("S").controlAsserted).toBe(true);
    expect(group.nonControllingInterest("S").toPercentString()).toBe("55%");
  });

  it("lets a definition deny control a majority would give", () => {
    const group = GroupStructure.build([
      { code: "P", name: "Parent", currency: GBP },
      { code: "S", name: "Sub", currency: GBP, parent: "P", holding: "60", controlled: false },
    ]);
    expect(group.isControlled("S")).toBe(false);
    expect(group.consolidated().map((e) => e.code)).toEqual(["P"]);
  });

  it("an exact half is not control", () => {
    const group = GroupStructure.build([
      { code: "P", name: "Parent", currency: GBP },
      { code: "J", name: "Joint venture", currency: GBP, parent: "P", holding: "50" },
    ]);
    expect(group.isControlled("J")).toBe(false);
  });
});

describe("what the structure refuses", () => {
  it("rejects a duplicate code", () => {
    expect(() =>
      GroupStructure.build([
        { code: "P", name: "Parent", currency: GBP },
        { code: "P", name: "Also parent", currency: GBP },
      ]),
    ).toThrow(/Duplicate entity P/);
  });

  it("rejects a holder that is not in the group", () => {
    expect(() =>
      GroupStructure.build([
        { code: "P", name: "Parent", currency: GBP },
        { code: "S", name: "Sub", currency: GBP, parent: "X" },
      ]),
    ).toThrow(/not in the group/);
  });

  it("rejects a cycle", () => {
    expect(() =>
      GroupStructure.build([
        { code: "A", name: "A", currency: GBP, parent: "B" },
        { code: "B", name: "B", currency: GBP, parent: "A" },
      ]),
    ).toThrow(/cycle/);
  });

  it("rejects a longer cycle that still leaves a parent standing", () => {
    expect(() =>
      GroupStructure.build([
        { code: "P", name: "P", currency: GBP },
        { code: "A", name: "A", currency: GBP, heldBy: [{ holder: "C", interest: "100" }] },
        { code: "B", name: "B", currency: GBP, parent: "A" },
        { code: "C", name: "C", currency: GBP, parent: "B" },
      ]),
    ).toThrow(/A, B, C/);
  });

  it("rejects an entity that holds itself", () => {
    expect(() =>
      GroupStructure.build([
        { code: "P", name: "P", currency: GBP },
        { code: "S", name: "S", currency: GBP, parent: "S" },
      ]),
    ).toThrow(/cannot hold itself/);
  });

  it("rejects holdings that come to more than the whole company", () => {
    expect(() =>
      GroupStructure.build([
        { code: "P", name: "P", currency: GBP },
        { code: "S", name: "S", currency: GBP, parent: "P", holding: "60" },
        {
          code: "T",
          name: "T",
          currency: GBP,
          heldBy: [
            { holder: "P", interest: "70" },
            { holder: "S", interest: "40" },
          ],
        },
      ]),
    ).toThrow(/more than the whole company/);
  });

  it("rejects the same holder listed twice", () => {
    expect(() =>
      GroupStructure.build([
        { code: "P", name: "P", currency: GBP },
        {
          code: "S",
          name: "S",
          currency: GBP,
          heldBy: [
            { holder: "P", interest: "40" },
            { holder: "P", interest: "20" },
          ],
        },
      ]),
    ).toThrow(/twice/);
  });

  it("rejects a holding of nothing rather than carrying a phantom shareholder", () => {
    expect(() =>
      GroupStructure.build([
        { code: "P", name: "P", currency: GBP },
        { code: "S", name: "S", currency: GBP, parent: "P", holding: "0" },
      ]),
    ).toThrow(/holding nothing/);
  });

  it("rejects both forms of declaring a holder at once", () => {
    expect(() =>
      GroupStructure.build([
        { code: "P", name: "P", currency: GBP },
        {
          code: "S",
          name: "S",
          currency: GBP,
          parent: "P",
          heldBy: [{ holder: "P", interest: "50" }],
        },
      ]),
    ).toThrow(/one or the other/);
  });

  it("rejects a holding with nobody holding it", () => {
    expect(() =>
      GroupStructure.build([
        { code: "P", name: "P", currency: GBP },
        { code: "S", name: "S", currency: GBP, holding: "50" },
      ]),
    ).toThrow(/says nothing about who holds it/);
  });

  it("rejects a blank code", () => {
    expect(() => GroupStructure.build([{ code: "  ", name: "P", currency: GBP }])).toThrow(
      /needs a code/,
    );
  });

  it("throws a typed error for an entity it does not have", () => {
    const group = GroupStructure.build(CHAIN);
    expect(() => group.get("Z")).toThrow(UnknownEntityError);
    expect(group.find("Z")).toBeUndefined();
    expect(group.has("S")).toBe(true);
  });
});

describe("reading the structure", () => {
  it("records depth along the shortest chain and a principal chain for display", () => {
    const group = GroupStructure.build(CHAIN);
    expect(group.get("P").depth).toBe(0);
    expect(group.get("T").depth).toBe(2);
    expect(group.get("T").chain).toEqual(["P", "S", "T"]);
  });

  it("prefers the largest holding when naming the principal chain", () => {
    const group = GroupStructure.build([
      { code: "P", name: "P", currency: GBP },
      { code: "S", name: "S", currency: GBP, parent: "P", holding: "80" },
      {
        code: "T",
        name: "T",
        currency: GBP,
        heldBy: [
          { holder: "P", interest: "20" },
          { holder: "S", interest: "60" },
        ],
      },
    ]);
    expect(group.get("T").chain).toEqual(["P", "S", "T"]);
    expect(group.get("T").depth).toBe(1);
  });

  it("lists what an entity holds", () => {
    const group = GroupStructure.build(CHAIN);
    expect(group.get("P").heldEntities).toEqual(["S"]);
    expect(group.get("S").heldEntities).toEqual(["T"]);
    expect(group.get("T").heldEntities).toEqual([]);
  });

  it("keeps each entity's own functional currency and lists the set", () => {
    const group = GroupStructure.build(CHAIN);
    expect(group.get("S").currency.code).toBe("EUR");
    expect(group.currencies()).toEqual(["EUR", "GBP", "USD"]);
    expect(group.isSingleCurrency).toBe(false);
  });

  it("knows when no translation is needed at all", () => {
    const group = GroupStructure.build([
      { code: "P", name: "P", currency: GBP },
      { code: "S", name: "S", currency: "GBP", parent: "P" },
    ]);
    expect(group.isSingleCurrency).toBe(true);
  });

  it("keeps the acquisition date where one was given", () => {
    const group = GroupStructure.build(CHAIN);
    expect(group.get("T").acquired).toBe("2025-07-01");
    expect(group.get("P").acquired).toBeNull();
  });

  it("names the entities carrying a non-controlling interest", () => {
    const group = GroupStructure.build(CHAIN);
    expect(group.withNonControllingInterest().map((e) => e.code)).toEqual(["S", "T"]);
  });

  it("renders the structure with the ownership on each line", () => {
    const text = GroupStructure.build(CHAIN).render();
    expect(text).toContain("consolidated in GBP");
    expect(text).toContain("80% owned");
    expect(text).toContain("60% owned, 40% outside");
  });
});
