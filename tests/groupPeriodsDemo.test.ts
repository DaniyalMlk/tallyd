import { describe, expect, it } from "vitest";
import { GBP } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { comparedGroup, groupPeriodsReport } from "../src/demo/groupPeriods.js";

describe("the worked group over two periods", () => {
  const compared = comparedGroup();

  it("consolidates at both year ends and balances on each", () => {
    expect(compared.asAt).toBe("2026-12-31");
    expect(compared.comparativeAsAt).toBe("2025-12-31");
    expect(compared.current.balanced).toBe(true);
    expect(compared.prior.balanced).toBe(true);
    expect(compared.sound).toBe(true);
  });

  it("needs nothing kept from the earlier year: both come out of the same ledgers", () => {
    // Three files went in and two consolidations came out. If the prior year
    // had to have been prepared and stored, this would be impossible.
    expect(compared.prior.aggregation.entities.map((c) => c.entity)).toEqual(["HH", "HN", "HS"]);
    expect(compared.current.aggregation.entities.map((c) => c.entity)).toEqual(["HH", "HN", "HS"]);
  });

  it("reaches the outside stake two different ways and gets the same figure", () => {
    expect(compared.nci.closing.toDecimalString()).toBe("173748.58");
    expect(compared.nci.rolledForward.toDecimalString()).toBe("173748.58");
    expect(compared.nci.unexplained.isZero).toBe(true);
    const perEntity = compared.nciByEntity.reduce(
      (running, movement) => running.plus(movement.closing),
      Money.zero(GBP),
    );
    expect(perEntity.toDecimalString()).toBe("173748.58");
  });

  it("splits that stake the way the two holdings say it splits", () => {
    const nord = compared.nciByEntity.find((m) => m.entity === "HN");
    const systems = compared.nciByEntity.find((m) => m.entity === "HS");
    // 20% of Nord and 40% of Systems, the latter being the complement of the
    // 60% the group reaches through Nord's 75%.
    expect(nord?.opening.toDecimalString()).toBe("71100.00");
    expect(nord?.closing.toDecimalString()).toBe("71448.58");
    expect(systems?.opening.toDecimalString()).toBe("81620.00");
    expect(systems?.closing.toDecimalString()).toBe("102300.00");
  });

  it("gives the Systems stake its own goodwill and Nord's stake none", () => {
    const nord = compared.nciByEntity.find((m) => m.entity === "HN");
    const systems = compared.nciByEntity.find((m) => m.entity === "HS");
    // Systems' outside stake was measured at fair value, so it owns a slice of
    // the goodwill and therefore the exchange difference on that slice. Nord's
    // was measured proportionately, so it owns none of the goodwill and none
    // of the difference — and that is about the measurement, not the size of
    // the stake: Nord's 20% and Systems' 40% are the same kind of thing.
    expect(nord?.goodwillRetranslation.isZero).toBe(true);
    expect(systems?.goodwillRetranslation.toDecimalString()).toBe("-160.00");
    expect(nord?.unexplained.isZero).toBe(true);
    expect(systems?.unexplained.isZero).toBe(true);
  });

  it("reaches the translation reserve two different ways too", () => {
    expect(compared.translationReserve.closing.toDecimalString()).toBe("-27117.51");
    expect(compared.translationReserve.rolledForward.toDecimalString()).toBe("-27117.51");
    expect(compared.translationReserve.unexplained.isZero).toBe(true);
  });

  it("names goodwill's share of the reserve rather than leaving it unexplained", () => {
    // Four lines, not two: each subsidiary's own translation adjustment moved,
    // and so did the sterling amount its goodwill is carried at. The second of
    // those is in no entity's books, so without a line of its own it would sit
    // under "not explained by the above".
    const labels = compared.translationReserve.lines.map((l) => l.label);
    expect(labels).toEqual([
      "HN — movement on retranslation",
      "HS — movement on retranslation",
      "HN — goodwill retranslated",
      "HS — goodwill retranslated",
    ]);
    const goodwillLines = compared.translationReserve.lines
      .filter((l) => l.label.includes("goodwill"))
      .reduce((running, l) => running.plus(l.amount), Money.zero(GBP));
    expect(goodwillLines.toDecimalString()).toBe("-2607.10");
  });

  it("keeps the identity for every entity", () => {
    for (const movement of compared.netAssets) {
      const rolled = movement.opening
        .plus(movement.translationEffect)
        .plus(movement.result)
        .plus(movement.other);
      expect(rolled.equals(movement.closing)).toBe(true);
    }
  });

  it("leaves the investment held at cost out of the currency column", () => {
    const nord = compared.netAssets.find((m) => m.entity === "HN");
    // Nord's opening net assets are 355,500, of which 128,700 is what it paid
    // for Systems. Only the other 226,800 moves with the rate.
    expect(nord?.opening.toDecimalString()).toBe("355500.00");
    expect(nord?.translationEffect.toDecimalString()).toBe("-5400.00");
  });

  it("moves goodwill by the rate, because nothing here impairs it", () => {
    // Both subsidiaries keep their books abroad, so goodwill on each is an
    // asset of a foreign operation and moves with its closing rate. Nothing
    // impaired it, and that claim now lives where it belongs: on the
    // measurement, which is the same figure at both dates.
    const goodwill = compared.rows.find((r) => r.account === "1290");
    expect(goodwill?.prior.toDecimalString()).toBe("110945.60");
    expect(goodwill?.current.toDecimalString()).toBe("108178.50");
    expect(goodwill?.movement.toDecimalString()).toBe("-2767.10");

    const measured = compared.current.workings.map((w) =>
      w.goodwillCarrying.functional.toString(),
    );
    expect(measured).toEqual(["63030.30 EUR", "75324.87 USD"]);
    expect(measured).toEqual(
      compared.prior.workings.map((w) => w.goodwillCarrying.functional.toString()),
    );
  });
});

describe("how the two-period report reads", () => {
  const text = groupPeriodsReport();

  it("says which two dates it covers and where they came from", () => {
    expect(text).toContain("The same group, two years running");
    expect(text).toContain("Consolidated at 2026-12-31, with 2025-12-31 beside it");
    expect(text).toContain("same three ledgers");
  });

  it("prints all three schedules", () => {
    expect(text).toContain("Both columns, and what moved");
    expect(text).toContain("Where the movement came from");
    expect(text).toContain("The outside stake, rolled forward");
    expect(text).toContain("The translation reserve, rolled forward");
  });

  it("breaks the outside stake down per company as well as in total", () => {
    expect(text).toContain("HN Halden Nord GmbH — 20% held outside");
    expect(text).toContain("HS Halden Systems Inc — 40% held outside");
  });

  it("ends by checking the two routes against each other", () => {
    expect(text).toContain("Does it hang together");
    expect(text).toContain("Outside stake measured from the balance sheet");
    expect(text).toContain("Outside stake rolled forward from last year");
    expect(text).toContain("Two routes to each figure, and they agree.");
  });

  it("says nothing about disagreeing, because nothing does", () => {
    expect(text).not.toContain("THEY DISAGREE");
    expect(text).not.toContain("DO NOT AGREE");
    expect(text).not.toContain("Not explained by the above");
  });

  it("is plain text, with no control bytes to make git call the file binary", () => {
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)).toBe(false);
  });
});
