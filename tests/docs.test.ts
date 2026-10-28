/**
 * The site against the engine it describes.
 *
 * The page is generated, so the usual failure — a figure edited in the code
 * and not on the page — cannot happen. The failures that *can* happen are the
 * two this file is about:
 *
 * 1. **The page quotes something the gate does not say.** A figure that looks
 *    measured but was interpolated from somewhere else, or a label whose
 *    wording drifted from the row it is supposed to render.
 * 2. **The page stops quoting something.** A row dropped from the evidence
 *    table, or a count that silently became a constant.
 *
 * So the assertions run in both directions: every figure the page shows has to
 * appear in the gate's output, *and* every row the gate produces has to appear
 * on the page, counted rather than merely present. A forward-only check passes
 * on an empty page.
 *
 * What is deliberately not attempted is a scan of the page's numbers against
 * the gate's: the page writes `201 matched` and the gate writes percentages to
 * one decimal place, so a value-direction scan over free text would either
 * flag every ordinary numeral in a sentence or be loosened until it flagged
 * nothing. The rows are pinned whole instead, which is the check that would
 * actually catch a drift.
 */

import { describe, expect, it } from "vitest";
import { buildSite, counts, DASHBOARD, DASHBOARD_FILE, evidenceRows, PACKAGE, SOURCE } from "../docs/site.js";
import { reviewDashboard, SAMPLE } from "../docs/dashboard.js";
import { evidence, evidenceReport } from "../src/demo/evidence.js";
import { standardChart } from "../src/accounts/index.js";
import * as tallyd from "../src/index.js";

const dashboard = reviewDashboard();
const files = buildSite(dashboard);
const page = files.get("index.html") ?? "";
const style = files.get("style.css") ?? "";
const report = evidenceReport();
const rows = evidenceRows(report);

/** The row bodies: the header is a row too, and it is not evidence. */
const bodyRows = rows.slice(1);

describe("the site is the files it says it is", () => {
  it("is a page and a stylesheet, and nothing else", () => {
    expect([...files.keys()].sort()).toEqual(["index.html", "style.css"]);
  });

  it("links the stylesheet it ships and nothing it does not", () => {
    expect(page).toContain('<link rel="stylesheet" href="style.css">');
    expect(style.length).toBeGreaterThan(2000);
    // No network. The dashboard's whole claim is that it fetches nothing, and
    // a landing page around it that pulled in a font or a CDN script would
    // make that claim look like an accident.
    for (const pattern of [/https?:\/\/[^"' ]*\.(?:css|js)/, /<script/i, /@import/]) {
      expect(page).not.toMatch(pattern);
    }
  });

  it("points at the dashboard it publishes", () => {
    expect(page).toContain(`href="${DASHBOARD}"`);
    expect(page).toContain(`src="${DASHBOARD}"`);
    expect(DASHBOARD.endsWith("/")).toBe(true);
    expect(DASHBOARD_FILE).toBe("index.html");
  });

  it("names the package and the repository", () => {
    expect(PACKAGE).toBe("tallyd");
    expect(page).toContain(`npm install ${PACKAGE}`);
    expect(page).toContain(SOURCE);
  });
});

describe("every row the gate produces reaches the page", () => {
  it("renders the whole table, counted", () => {
    expect(bodyRows.length).toBeGreaterThanOrEqual(9);
    const cells = page.match(/<td>/g) ?? [];
    expect(cells.length).toBe(bodyRows.length * 2);
    const headers = page.match(/<th>/g) ?? [];
    expect(headers.length).toBe(rows[0]?.length ?? 0);
  });

  it("renders each row whole, label and result together", () => {
    // Not label-presence and result-presence separately: a generator that
    // paired the wrong result with a label would pass both of those.
    const escape = (text: string): string =>
      text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/`([^`]+)`/g, (_, inner: string) => `<code>${inner}</code>`);

    for (const row of bodyRows) {
      const [check, result] = row;
      expect(row).toHaveLength(2);
      expect(page).toContain(
        `<tr><td>${escape(check ?? "")}</td><td>${escape(result ?? "")}</td></tr>`,
      );
    }
  });

  it("keeps the row count honest in both directions", () => {
    // Dropping a row from the gate and leaving the page alone, or vice versa,
    // has to fail. The table is the only place `<td>` appears, so the count
    // above is the gate's count and this says so explicitly.
    const rendered = (page.match(/<\/tr>/g) ?? []).length;
    expect(rendered).toBe(rows.length);
  });
});

describe("every figure quoted outside the table is measured", () => {
  const measured = evidence();

  it("quotes the consolidation residual as the gate reports it", () => {
    // In its own markup, not anywhere on the page. A break sweep caught this:
    // the headline was typed as `0.01 GBP` and a bare containment check still
    // passed, because the right figure was sitting in the evidence table two
    // screens further down. Every figure quoted outside the table is pinned to
    // the element it is rendered into for that reason.
    expect(page).toContain(`<strong>${measured.exact.groupResidual}</strong>`);
    expect(report).toContain(measured.exact.groupResidual);
    // The claim is that it is nil, so the page would be making a different
    // and much weaker point if it ever stopped being nil.
    expect(measured.exact.groupResidual).toMatch(/^-?0\.00 [A-Z]{3}$/);
  });

  it("quotes the wrong-match count and the period count", () => {
    expect(page).toContain(`<strong>${measured.accuracy.wrong}</strong>`);
    expect(page).toContain(`over ${measured.accuracy.seeds} periods`);
    expect(page).toContain(measured.accuracy.links.toLocaleString("en-GB"));
  });

  it("quotes the index selectivity from the largest sample measured", () => {
    const largest = measured.index[measured.index.length - 1];
    expect(largest).toBeDefined();
    expect(page).toContain(`<strong>${(largest?.ratio ?? 0).toFixed(0)}&times;</strong>`);
  });

  it("quotes the learning effect in the direction the gate measured it", () => {
    const { learning } = measured;
    const cold = (learning.coldRecall * 100).toFixed(1);
    const warm = (learning.warmRecall * 100).toFixed(1);
    // Both figures in one string, in order. Asserting them separately passes
    // on a page that quotes the warm figure twice -- which is what a sweep
    // that swapped the two produced, because the evidence table carries the
    // cold figure and satisfied the second half on its own.
    expect(page).toContain(`lifted recall from\n    ${cold}% to\n    ${warm}% in`);
    expect(page).toContain(`from ${learning.coldQueue} to\n    ${learning.warmQueue}`);
    expect(learning.warmRecall).toBeGreaterThan(learning.coldRecall);
    expect(learning.warmQueue).toBeLessThan(learning.coldQueue);
  });

  it("quotes precision as the worst the sweep saw, not the mean", () => {
    expect(page).toContain(
      `below\n  ${measured.accuracy.worstPrecision.toFixed(3)}, and that is deliberate`,
    );
    // A different measurement that happens to share a value: the warm figure
    // is the one the memory section quotes, and pinning it to the worst-period
    // figure would make the page pass on a day they diverged.
    expect(page).toContain(
      `precision still\n    ${measured.learning.warmPrecision.toFixed(3)}`,
    );
    expect(measured.accuracy.worstPrecision).toBe(1);
  });
});

describe("every count is read off the thing it counts", () => {
  it("agrees with the chart of accounts", () => {
    const size = counts();
    expect(size.accounts).toBe(standardChart().size);
    expect(size.accounts).toBeGreaterThan(30);
    expect(page).toContain(`chart of\n  ${size.accounts} accounts`);
  });

  it("agrees with what the package exports", () => {
    const size = counts();
    expect(size.exports).toBe(Object.keys(tallyd).length);
    // The tarball-install job in CI asserts the same floor from outside the
    // repository; this is the inside half of that claim.
    expect(size.exports).toBeGreaterThan(100);
    expect(page).toContain(`exports\n  ${size.exports} names`);
  });
});

describe("the dashboard the page describes", () => {
  it("is built from a fixed sample, so the page can be written about it", () => {
    expect(SAMPLE).toEqual({
      seed: 11,
      months: 12,
      invoicesPerMonth: 12,
      start: "2026-01-01",
    });
    const again = reviewDashboard();
    expect(again.html.length).toBe(dashboard.html.length);
    expect(again.matched).toBe(dashboard.matched);
  });

  it("is one self-contained file that fetches nothing", () => {
    expect(dashboard.html.startsWith("<!doctype html>")).toBe(true);
    for (const pattern of [/<link /i, /src="http/i, /fetch\(/, /XMLHttpRequest/]) {
      expect(dashboard.html).not.toMatch(pattern);
    }
  });

  it("has a queue worth working through", () => {
    // The point of publishing the generator's books rather than the demo
    // month: a reviewer arriving on the page needs something to decide.
    expect(dashboard.toReview).toBeGreaterThan(20);
    expect(dashboard.matched).toBeGreaterThan(100);
    expect(dashboard.bookLines).toBeGreaterThan(200);
  });

  it("is quoted on the page with its own counts and its own size", () => {
    expect(page).toContain(`${dashboard.bookLines} cash`);
    expect(page).toContain(`${dashboard.statementLines} statement lines`);
    expect(page).toContain(`${dashboard.matched} of them paired outright`);
    expect(page).toContain(`${dashboard.toReview} queued`);
    expect(page).toContain(`${dashboard.unexplained} the books never saw`);
    expect(page).toContain(`${Math.round(dashboard.html.length / 1024)}&nbsp;KB`);
  });
});
