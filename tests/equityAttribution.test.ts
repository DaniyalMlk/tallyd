/**
 * Attributing the period result to an equity account.
 *
 * The result for the period is a synthesised line. Nothing has closed income
 * and expenses out, so there is no entry behind it and no account holding it,
 * and the footnote under the report says so in as many words. The option that
 * puts an account code on that line is therefore not saying where the result
 * *is*; it is a caller stating where it belongs, from knowledge the ledger
 * does not have.
 *
 * Which is worth having, and was worth checking. Unchecked, the option
 * accepted any string: a fixed-asset code printed `1210  Result for the
 * period` inside the equity section of a sheet that still reported itself
 * balanced, and a code belonging to no account at all was accepted in exactly
 * the same silence.
 *
 * The two halves below are the ones that have to stay true together:
 * attribution changes the label and nothing else, and a label the chart
 * cannot support is refused.
 */

import { describe, expect, it } from "vitest";
import { GBP, Money } from "../src/money/index.js";
import { date } from "../src/ledger/date.js";
import { Ledger } from "../src/ledger/ledger.js";
import { standardChart } from "../src/accounts/standard.js";
import {
  BalanceSheetError,
  balanceSheet,
  renderBalanceSheet,
} from "../src/reports/balanceSheet.js";

const chart = standardChart("GBP");
const asAt = date("2026-03-31");

/** Capital in, one sale out: equity booked, and a result not yet closed. */
function books(): Ledger {
  return Ledger.empty(chart)
    .record({
      id: "JE-1",
      date: date("2026-01-01"),
      narration: "capital introduced",
      postings: [
        { account: "1210", amount: Money.parse("10000.00", GBP) },
        { account: "3100", amount: Money.parse("-10000.00", GBP) },
      ],
    })
    .record({
      id: "JE-2",
      date: date("2026-02-01"),
      narration: "a sale",
      postings: [
        { account: "1210", amount: Money.parse("4000.00", GBP) },
        { account: "4100", amount: Money.parse("-4000.00", GBP) },
      ],
    });
}

const resultRow = (ledger: Ledger, account?: string) => {
  const sheet = balanceSheet(
    ledger,
    asAt,
    account === undefined ? {} : { retainedEarningsAccount: account },
  );
  const row = sheet.equity.rows.find((candidate) => candidate.synthetic);
  expect(row, "there is always a synthesised result line").toBeDefined();
  return { sheet, row: row! };
};

describe("by default the result line names no account", () => {
  it("carries an empty code, deliberately", () => {
    // Not an oversight to be filled in. The comment on the option used to
    // promise a default of "3200" when the chart held it; the chart does hold
    // it, and the default is still nothing.
    expect(chart.has("3200")).toBe(true);
    const { row } = resultRow(books());
    expect(row.account).toBe("");
    expect(row.name).toBe("Result for the period");
  });

  it("renders as a bare label, and says why underneath", () => {
    const rendered = renderBalanceSheet(balanceSheet(books(), asAt));
    expect(rendered).toContain("  Result for the period *");
    expect(rendered).not.toContain("3200  Result for the period");
    // The footnote is the other half of the same claim: were the line to
    // carry 3200 by default, the report would contradict itself here.
    expect(rendered).toContain("rather than sitting in retained earnings");
  });
});

describe("naming an equity account changes the label and nothing else", () => {
  it("puts the code on the line", () => {
    const { row } = resultRow(books(), "3200");
    expect(row.account).toBe("3200");
    expect(renderBalanceSheet(balanceSheet(books(), asAt, { retainedEarningsAccount: "3200" }))).toContain(
      "3200  Result for the period *",
    );
  });

  it("leaves the line synthesised, because nothing was posted", () => {
    // The distinction the whole option rests on. Attribution is not posting:
    // the star stays, the footnote stays, and no entry appeared.
    const named = resultRow(books(), "3200");
    expect(named.row.synthetic).toBe(true);
    expect(named.sheet.equity.rows.filter((row) => row.synthetic)).toHaveLength(1);
    expect(books().all()).toHaveLength(2);
    expect(renderBalanceSheet(named.sheet)).toContain("rather than sitting in retained earnings");
  });

  it("leaves every figure on the sheet where it was", () => {
    const plain = balanceSheet(books(), asAt);
    const named = balanceSheet(books(), asAt, { retainedEarningsAccount: "3200" });
    expect(named.resultForPeriod.minorUnits).toBe(plain.resultForPeriod.minorUnits);
    expect(named.equity.total.minorUnits).toBe(plain.equity.total.minorUnits);
    expect(named.totalLiabilitiesAndEquity.minorUnits).toBe(plain.totalLiabilitiesAndEquity.minorUnits);
    expect(named.difference.isZero).toBe(true);
    expect(named.balanced).toBe(true);
    // And the figures are the ones this ledger actually implies, so the
    // equality above is not two nils agreeing.
    expect(plain.resultForPeriod.toDecimalString()).toBe("4000.00");
    expect(plain.equity.total.toDecimalString()).toBe("14000.00");
  });

  it("accepts a placeholder reserve, which is not postable", () => {
    // Nothing is posted, so postability is not the question. 3000 is the
    // equity parent and the ledger would refuse an entry against it.
    expect(chart.isPostable("3000")).toBe(false);
    expect(resultRow(books(), "3000").row.account).toBe("3000");
  });
});

describe("a label the chart cannot support is refused", () => {
  const rejected: readonly [string, string, RegExp][] = [
    ["a fixed-asset account", "1210", /not equity/],
    ["an income account", "4100", /not equity/],
    ["a liability account", "2100", /not equity/],
    ["an account the chart has never heard of", "ZZZZ", /no such account/],
  ];

  it.each(rejected)("refuses %s", (_label, code, message) => {
    expect(() => balanceSheet(books(), asAt, { retainedEarningsAccount: code })).toThrow(
      BalanceSheetError,
    );
    expect(() => balanceSheet(books(), asAt, { retainedEarningsAccount: code })).toThrow(message);
  });

  it("names the account and its type, so the message is actionable", () => {
    expect(() => balanceSheet(books(), asAt, { retainedEarningsAccount: "1210" })).toThrow(
      /1210 \(Equipment\): it is an asset account, not equity/,
    );
  });

  it("would have drawn the sheet anyway, which is what made it worth refusing", () => {
    // What the old behaviour produced: a sheet claiming to balance, with a
    // fixed-asset code in the equity section. The arithmetic was never wrong
    // — that is precisely why nothing noticed.
    const sheet = balanceSheet(books(), asAt);
    expect(sheet.balanced).toBe(true);
    expect(sheet.equity.rows.map((row) => row.account)).toEqual(["3100", ""]);
  });

  it("takes the caller's word when the ledger carries no chart", () => {
    // There is nothing to check against, and refusing would make the check
    // depend on whether a chart was supplied rather than on the code.
    const chartless = Ledger.empty().record({
      id: "JE-1",
      date: date("2026-01-01"),
      narration: "a sale",
      postings: [
        { account: "1210", amount: Money.parse("500.00", GBP) },
        { account: "4100", amount: Money.parse("-500.00", GBP) },
      ],
    });
    const sheet = balanceSheet(chartless, asAt, { retainedEarningsAccount: "whatever" });
    expect(sheet.equity.rows.find((row) => row.synthetic)?.account).toBe("whatever");
  });
});
