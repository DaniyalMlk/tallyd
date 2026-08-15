import { describe, expect, it } from "vitest";
import { GBP, Money } from "../src/money/index.js";
import { importCsv } from "../src/statement/import.js";
import { bankView } from "../src/reconcile/bankView.js";
import { reconcile } from "../src/reconcile/matcher.js";
import { statementClosingBalance } from "../src/reconcile/bridge.js";
import { dashboardData, type DashboardData, type LineView } from "../src/dashboard/model.js";
import { embedJson, escapeHtml, renderDashboard } from "../src/dashboard/render.js";
import { cashPositionChart, confidenceChart } from "../src/dashboard/charts.js";
import { demoLedger } from "../src/demo/month.js";
import { DEMO_BANK_CSV } from "../src/demo/statement.js";
import { supplierRunLedger, SUPPLIER_RUN_CSV } from "../src/demo/supplierRun.js";
import { Ledger } from "../src/ledger/index.js";
import { standardChart } from "../src/accounts/index.js";

function build(ledgerBuilder: () => ReturnType<typeof demoLedger>, csv: string): DashboardData {
  const ledger = ledgerBuilder();
  const imported = importCsv(csv, { currency: GBP, idPrefix: "BANK" });
  const statement = [...imported.lines, ...imported.duplicates.map((flag) => flag.line)].sort(
    (a, b) => a.sourceRow - b.sourceRow,
  );
  const books = bankView(ledger, "1110");
  const result = reconcile(books, statement);
  return dashboardData({
    ledger,
    account: "1110",
    books,
    statement,
    result,
    bankClosingBalance: statementClosingBalance(statement, Money.zero(GBP)),
    bookClosingBalance: books.reduce((total, line) => total.plus(line.amount), Money.zero(GBP)),
    statementFormat: "csv",
  });
}

const month = build(demoLedger, DEMO_BANK_CSV);
const supplier = build(supplierRunLedger, SUPPLIER_RUN_CSV);

const sumMinor = (lines: readonly LineView[]): number =>
  lines.reduce((total, line) => total + line.amount.minor, 0);

describe("dashboardData", () => {
  it("carries the same counts the matcher produced", () => {
    expect(month.matched).toHaveLength(7);
    expect(month.suggested).toHaveLength(2);
    expect(month.unmatchedBook).toHaveLength(1);
    expect(month.unmatchedStatement).toHaveLength(3);
  });

  it("survives a JSON round trip with nothing lost", () => {
    const restored = JSON.parse(JSON.stringify(month)) as DashboardData;
    expect(restored).toEqual(month);
  });

  it("gives every amount both a display string and exact minor units", () => {
    const everyLine = [
      ...month.unmatchedBook,
      ...month.unmatchedStatement,
      ...month.matched.flatMap((match) => [...match.book, ...match.statement]),
      ...month.suggested.flatMap((match) => [...match.book, ...match.statement]),
    ];
    expect(everyLine.length).toBeGreaterThan(10);
    for (const line of everyLine) {
      expect(Number.isSafeInteger(line.amount.minor)).toBe(true);
      expect(Number(line.amount.text.replace(/,/g, ""))).toBeCloseTo(line.amount.minor / 100, 6);
    }
  });

  it("labels each line with the side it came from", () => {
    for (const match of [...month.matched, ...month.suggested]) {
      expect(match.book.every((line) => line.side === "book")).toBe(true);
      expect(match.statement.every((line) => line.side === "bank")).toBe(true);
    }
    expect(month.unmatchedBook.every((line) => line.side === "book")).toBe(true);
    expect(month.unmatchedStatement.every((line) => line.side === "bank")).toBe(true);
  });

  it("spans the period the two sides actually cover", () => {
    expect(month.period.from).toBe("2026-08-01");
    expect(month.period.to).toBe("2026-08-31");
  });

  it("counts confidence bands in a fixed order, including the empty ones", () => {
    expect(month.confidence.map((band) => band.label)).toEqual(["exact", "high", "medium", "low"]);
    const total = month.confidence.reduce((sum, band) => sum + band.count, 0);
    expect(total).toBe(month.matched.length + month.suggested.length);
  });

  it("runs the cash position forward to the ledger's own balance", () => {
    const last = month.cashPosition[month.cashPosition.length - 1];
    expect(last?.minor).toBe(month.bookClosingMinor);
    const dates = month.cashPosition.map((point) => point.date);
    expect(dates).toEqual([...dates].sort());
  });

  it("shows grouping accounts rolled up, and hides ones nothing touched", () => {
    const byCode = new Map(month.accounts.map((account) => [account.code, account]));
    // 1000 Assets is a placeholder; its balance is the subtree's.
    expect(byCode.get("1000")?.balance.text).toBe("23143.58");
    expect(byCode.get("1110")?.balance.text).toBe("23143.58");
    // Nothing has ever been posted to petty cash, so it does not appear.
    expect(byCode.has("1120")).toBe(false);
    expect(byCode.has("1210")).toBe(false);
  });

  it("lists every posting, not just the bank ones", () => {
    expect(month.postings.length).toBeGreaterThan(month.cashPosition.length);
    const bankPostings = month.postings.filter((posting) => posting.account === "1110");
    expect(bankPostings).toHaveLength(10);
    expect(bankPostings[0]?.contra).toEqual(["3100"]);
  });
});

describe("the bridge the page will compute", () => {
  /**
   * The client re-adds the bridge in the browser on every decision. These
   * assertions run the same arithmetic over the embedded data, so a page that
   * would open showing a difference fails here rather than in front of a user.
   */
  const bridgeDifference = (data: DashboardData, acceptedIds: readonly string[] = []): number => {
    const stillSuggested = data.suggested.filter((match) => !acceptedIds.includes(match.id));
    const outstandingBook = [
      ...data.unmatchedBook,
      ...stillSuggested.flatMap((match) => match.book),
    ];
    const outstandingStatement = [
      ...data.unmatchedStatement,
      ...stillSuggested.flatMap((match) => match.statement),
    ];
    return (
      data.bankClosingMinor +
      sumMinor(outstandingBook) -
      (data.bookClosingMinor + sumMinor(outstandingStatement))
    );
  };

  it("balances on load for both worked examples", () => {
    expect(bridgeDifference(month)).toBe(0);
    expect(bridgeDifference(supplier)).toBe(0);
  });

  it("still balances after every possible sequence of acceptances", () => {
    for (const data of [month, supplier]) {
      const ids = data.suggested.map((match) => match.id);
      // Every subset, since accepting is order-independent and the set is small.
      for (let mask = 0; mask < 1 << ids.length; mask++) {
        const accepted = ids.filter((_, index) => (mask & (1 << index)) !== 0);
        expect(bridgeDifference(data, accepted)).toBe(0);
      }
    }
  });

  it("keeps the two sides of a match equal, which is why acceptance is safe", () => {
    for (const data of [month, supplier]) {
      for (const match of [...data.matched, ...data.suggested]) {
        expect(sumMinor(match.book)).toBe(sumMinor(match.statement));
      }
    }
  });
});

describe("escaping", () => {
  it("neutralises the characters that would break out of markup", () => {
    expect(escapeHtml(`<b>"Tom & Jerry's"</b>`)).toBe(
      "&lt;b&gt;&quot;Tom &amp; Jerry&#39;s&quot;&lt;/b&gt;",
    );
    expect(escapeHtml("plain")).toBe("plain");
    expect(escapeHtml("")).toBe("");
  });

  it("stops embedded JSON closing its own script element", () => {
    const embedded = embedJson({ narration: "see </script><script>alert(1)</script> for detail" });
    expect(embedded).not.toContain("</script>");
    expect(embedded).toContain("\\u003c");
    expect(JSON.parse(embedded.replace(/\\u003c/g, "<").replace(/\\u003e/g, ">"))).toEqual({
      narration: "see </script><script>alert(1)</script> for detail",
    });
  });

  it("escapes the line separators that are legal JSON but illegal JavaScript", () => {
    expect(embedJson({ text: "a b c" })).toContain("\\u2028");
    expect(embedJson({ text: "a b c" })).toContain("\\u2029");
  });
});

describe("charts", () => {
  it("says so when there is nothing to plot", () => {
    expect(cashPositionChart([], { exponent: 2, symbol: "£" })).toContain("No movements");
    expect(confidenceChart([{ label: "exact", count: 0 }])).toContain("Nothing matched");
  });

  it("places points by date, not by position in the list", () => {
    // Two gaps, one three days and one thirteen. Drawn by index they would be
    // the same width; drawn by date the second is much wider.
    const svg = cashPositionChart(
      [
        { date: "2026-08-01", minor: 100 },
        { date: "2026-08-04", minor: 200 },
        { date: "2026-08-17", minor: 300 },
      ],
      { exponent: 2, symbol: "£" },
    );
    const xs = [...svg.matchAll(/class="marker"[^>]*cx="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(xs).toHaveLength(3);
    const firstGap = (xs[1] as number) - (xs[0] as number);
    const secondGap = (xs[2] as number) - (xs[1] as number);
    expect(secondGap / firstGap).toBeCloseTo(13 / 3, 1);
  });

  it("centres a single point rather than pinning it to an edge", () => {
    const svg = cashPositionChart([{ date: "2026-08-01", minor: 500 }], {
      exponent: 2,
      symbol: "£",
    });
    expect(svg).toContain('class="marker"');
    expect(svg).not.toContain("NaN");
  });

  it("rounds the axis to figures a person would choose", () => {
    const svg = cashPositionChart(
      [
        { date: "2026-08-01", minor: 0 },
        { date: "2026-08-31", minor: 2_314_358 },
      ],
      { exponent: 2, symbol: "£" },
    );
    expect(svg).toContain("£30k");
    expect(svg).not.toContain("23143.58");
  });

  it("steps the confidence bars from one hue, darkest first", () => {
    const svg = confidenceChart([
      { label: "exact", count: 4 },
      { label: "high", count: 3 },
      { label: "medium", count: 2 },
      { label: "low", count: 0 },
    ]);
    expect(svg.indexOf("var(--seq-4)")).toBeLessThan(svg.indexOf("var(--seq-3)"));
    expect(svg).toContain(">exact<");
    expect(svg).toContain("4 matches");
  });

  it("never emits NaN, whatever the numbers", () => {
    const inputs = [
      [{ date: "2026-08-01", minor: 0 }],
      [
        { date: "2026-08-01", minor: -5000 },
        { date: "2026-08-02", minor: -5000 },
      ],
      [
        { date: "2026-08-01", minor: -100 },
        { date: "2026-08-02", minor: 100 },
      ],
    ];
    for (const points of inputs) {
      const svg = cashPositionChart(points, { exponent: 2, symbol: "£" });
      expect(svg).not.toContain("NaN");
      expect(svg).not.toContain("Infinity");
    }
  });
});

describe("renderDashboard", () => {
  const html = renderDashboard(month);

  it("is one self-contained document that needs no network", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("<link ");
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toContain("@import");
  });

  it("carries every match and leftover into the markup", () => {
    for (const match of [...month.matched, ...month.suggested]) {
      expect(html).toContain(`data-match-id="${match.id}"`);
    }
    for (const line of month.unmatchedStatement) {
      // Leftovers are rendered by the client from the embedded data.
      expect(html).toContain(escapeHtml(line.description));
    }
  });

  it("offers actions only on the suggestions", () => {
    const accepts = [...html.matchAll(/data-action="accept"/g)];
    expect(accepts).toHaveLength(month.suggested.length);
    for (const match of month.matched) {
      const card = html.slice(html.indexOf(`data-match-id="${match.id}"`));
      expect(card.slice(0, card.indexOf("</article>"))).not.toContain("data-action");
    }
  });

  it("names the account and the period in the masthead", () => {
    expect(html).toContain("<h1>Bank reconciliation</h1>");
    expect(html).toContain("1110 Bank");
    expect(html).toContain("2026-08-01 to 2026-08-31");
  });

  it("gives the ledger rows keyboard reach", () => {
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-selected="false"');
  });

  it("keeps a live region for announcing decisions", () => {
    expect(html).toContain('id="live-region"');
    expect(html).toContain('aria-live="polite"');
  });

  it("escapes a hostile bank descriptor rather than rendering it", () => {
    const nasty = build(
      () =>
        Ledger.empty(standardChart(GBP)).record({
          id: "JE-1",
          date: "2026-08-01",
          narration: '<img src=x onerror="alert(1)">',
          postings: [
            { account: "1110", amount: Money.parse("10.00", GBP) },
            { account: "4100", amount: Money.parse("-10.00", GBP) },
          ],
        }),
      ["Date,Description,Paid Out,Paid In,Balance", "01/08/2026,<script>alert(1)</script>,,10.00,10.00"].join(
        "\n",
      ),
    );
    const rendered = renderDashboard(nasty);
    expect(rendered).not.toContain("<script>alert(1)</script>");
    expect(rendered).not.toContain('<img src=x onerror="alert(1)">');
    expect(rendered).toContain("&lt;img src=x onerror=");
  });

  it("renders both worked examples without a hole in the markup", () => {
    for (const data of [month, supplier]) {
      const rendered = renderDashboard(data);
      // The client script legitimately mentions `undefined`; the markup and
      // the embedded data must not.
      const markup = rendered.slice(0, rendered.indexOf("<script>window.__TALLYD__"));
      const embedded = rendered.slice(
        rendered.indexOf("<script>window.__TALLYD__"),
        rendered.indexOf("</script>", rendered.indexOf("<script>window.__TALLYD__")),
      );
      for (const chunk of [markup, embedded]) {
        expect(chunk).not.toContain("undefined");
        expect(chunk).not.toContain("NaN");
        expect(chunk).not.toContain("[object Object]");
      }
      expect(embedded.length).toBeGreaterThan(1000);
    }
  });
});
