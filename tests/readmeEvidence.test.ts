/**
 * The figures on the front page are the figures the code produces.
 *
 * A table of measured results is worth exactly as much as the guarantee that
 * it still matches. A number copied into a document once stops being true
 * quietly: the engine changes, the suite stays green because nothing in it
 * reads the document, and the README goes on claiming an accuracy the matcher
 * no longer has.
 *
 * So the claim is pinned here, in both directions. Every figure the README
 * quotes has to appear in the output of `src/demo/evidence.ts`, which is
 * itself a gate — it throws if a figure moves outside the band the README
 * states. And every row label has to still be in the document, which is the
 * other way a claim disappears: somebody deletes it.
 *
 * This test is also what makes "runs in CI" true. CI runs `npm test`, so the
 * evidence report runs here rather than in a workflow step of its own, and a
 * figure that moves fails the suite on the commit that moved it.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { evidence, evidenceReport } from "../src/demo/evidence.js";

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");

/**
 * Figures the README quotes, exactly as the evidence report prints them.
 *
 * Written out rather than parsed out of the README on purpose: deleting a row
 * from the table should not silently delete the check that defends it.
 */
const QUOTED = [
  "1,786 links, 0 wrong matches, precision 1.000 in every period",
  "recall 64.8%, 94.9% with suggestions",
  "269 of 90,144 (335x), 1,172 of 1,760,979 (1503x) at 1,419 movements",
  "recall 75.6% to 89.0%, queue 16 to 5 (68.8% shorter), precision still 1.000",
  "640042.62 GBP against 640042.62 GBP, difference 0.00 GBP",
  "9 balanced entries, translation reserve -22164.01 GBP against an adjustment of 22164.01 GBP, residual 0.00 GBP",
  "20000.00 and 25000.00 on the same 100000.00 of stock, the second carrying goods that cost 80000.00 at 75000.00",
  "stock down 20000.00 either way; the outside quarter bears 5000.00 when its company sold and 0.00 when it only bought",
] as const;

/**
 * Row labels from the evidence table. Presence is what is checked, not the
 * value beside it — see the test below for why that direction is the wrong one
 * to scan for.
 */
const ROWS = [
  "The matcher against generated books with an answer key, 20 periods",
  "The worst of those periods, unattended and then with the review queue",
  "Candidate pairs the amount-and-date index lets through to scoring",
  "A counterparty confirmed once, in the next period's unrelated books",
  "Trial balance over 625 generated journal entries",
  "A three-company, three-currency consolidation",
  "The same quarter read as a markup on cost and as a margin on price",
  "One consignment of intragroup stock, sent up to the parent and then down to the subsidiary",
] as const;

describe("the front page's figures", () => {
  // Measured once: the sweep reconciles twenty-odd windows of generated books
  // and the group consolidation on top, which is several seconds of work.
  const report = evidenceReport();

  it.each(QUOTED)("the README quotes %s, and the report prints it", (figure) => {
    expect(report).toContain(figure);
    expect(README).toContain(figure);
  });

  it.each(ROWS)("the evidence table still has the row: %s", (row) => {
    expect(README).toContain(row);
  });

  it("the report is the table, so a new row cannot go unquoted", () => {
    // The report renders the table itself. Counting its rows against the
    // figures pinned above catches the case where a row is added to the
    // evidence and nobody puts it on the front page -- or puts it there
    // without pinning it.
    const rows = report
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| ---"))
      .filter((line) => line !== "| Check | Result |");
    expect(rows).toHaveLength(QUOTED.length);
    for (const line of rows) expect(README).toContain(line);
  });
});

describe("the bands the front page's prose claims", () => {
  // The prose around the table makes claims the table does not: that the
  // sweep is twenty periods, that precision is perfect everywhere, that the
  // index figure is the one measured at the largest size. Those are read off
  // the measurement rather than off its rendering.
  const measured = evidence();

  it("is twenty periods, not one", () => {
    // One seed proves nothing -- a matcher tuned on a single dataset scores
    // well on it by construction.
    expect(measured.accuracy.seeds).toBe(20);
    expect(measured.accuracy.links).toBeGreaterThan(1000);
  });

  it("auto-accepts nothing wrong, in any period", () => {
    expect(measured.accuracy.wrong).toBe(0);
    expect(measured.accuracy.worstPrecision).toBe(1);
  });

  it("recovers with the queue what it declines to accept unattended", () => {
    // The gap between these two is the conservative behaviour the score
    // thresholds exist for, so it should be a real gap rather than a rounding
    // one -- otherwise the review queue is not doing anything.
    expect(measured.accuracy.worstRecallWithSuggestions).toBeGreaterThan(
      measured.accuracy.worstRecall + 0.1,
    );
  });

  it("quotes the index figure measured at the largest size it ran", () => {
    const sizes = measured.index.map((point) => point.bookLines);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    const largest = measured.index[measured.index.length - 1];
    expect(largest?.bookLines).toBe(1419);
    expect(largest?.ratio).toBeGreaterThan(1000);
  });

  it("states zero where the arithmetic is exact", () => {
    // Not "within a tolerance": amounts are integer minor units, so there is
    // no tolerance to choose and a difference of zero is the literal string.
    expect(measured.exact.trialBalanceDifference).toBe("0.00 GBP");
    expect(measured.exact.groupDifference).toBe("0.00 GBP");
    expect(measured.exact.groupResidual).toBe("0.00 GBP");
    expect(measured.exact.groupBalanced).toBe(true);
  });

  it("balances the translation reserve against the adjustment exactly", () => {
    // The claim in the prose is that the reserve is the adjustment with its
    // sign flipped, which is what distinguishes it from a plug. Read as
    // strings, because that is what the README prints.
    const adjustment = measured.exact.translationAdjustment;
    const reserve = measured.exact.translationReserve;
    expect(reserve).toBe(`-${adjustment}`);
  });
});

describe("the suite size on the front page", () => {
  it("is not wildly stale", () => {
    // A loose bound deliberately. Pinning the exact count fails on every
    // commit that adds a test, which trains people to update the number
    // without reading it. This still catches the README claiming hundreds
    // when there are thousands.
    //
    // The count comes from the workspace rather than from a collection run:
    // starting vitest from inside vitest is not worth the minute it costs.
    const claimed = /([\d,]+) tests/.exec(README);
    expect(claimed).not.toBeNull();
    const stated = Number((claimed?.[1] ?? "0").replace(/,/g, ""));
    expect(stated).toBeGreaterThan(1400);
    expect(stated).toBeLessThan(2600);
  });

  it("names every demo script the package defines", () => {
    // The "Running it from source" block is a list of commands, and a demo
    // added without a line there is a demo nobody runs.
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    const demos = Object.keys(manifest.scripts).filter((name) =>
      name.startsWith("demo"),
    );
    expect(demos.length).toBeGreaterThan(5);
    for (const demo of demos) expect(README).toContain(`npm run ${demo}`);
  });
});
