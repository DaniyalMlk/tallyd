import { describe, expect, it } from "vitest";
import { JournalEntry } from "../src/ledger/entry.js";
import { Ledger } from "../src/ledger/ledger.js";
import { dateRange } from "../src/ledger/date.js";
import { standardChart } from "../src/accounts/standard.js";
import { GBP, USD } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { RateTable } from "../src/fx/table.js";
import {
  type TranslatedRow,
  TranslationError,
  renderTranslation,
  translate,
} from "../src/fx/translate.js";

const CHART = standardChart("GBP");

const RATES = RateTable.of(
  [
    { date: "2025-01-02", base: "GBP", quote: "USD", rate: "1.2000" },
    { date: "2026-01-01", base: "GBP", quote: "USD", rate: "1.2500" },
    { date: "2026-06-30", base: "GBP", quote: "USD", rate: "1.3000" },
    { date: "2026-12-31", base: "GBP", quote: "USD", rate: "1.3500" },
  ],
  { maxStaleDays: 400 },
);

/**
 * A small sterling company: capital subscribed in 2025, a year of trading in
 * 2026, and cash left over.
 */
function books(): Ledger {
  return Ledger.from(
    [
      JournalEntry.simple(
        {
          id: "JE-CAP",
          date: "2025-01-02",
          narration: "Share capital subscribed",
          debit: "1110",
          credit: "3100",
          amount: Money.parse("10000.00", GBP),
        },
        CHART,
      ),
      JournalEntry.simple(
        {
          id: "JE-SALE",
          date: "2026-06-30",
          narration: "Consulting revenue",
          debit: "1110",
          credit: "4200",
          amount: Money.parse("40000.00", GBP),
        },
        CHART,
      ),
      JournalEntry.simple(
        {
          id: "JE-RENT",
          date: "2026-06-30",
          narration: "Rent",
          debit: "5300",
          credit: "1110",
          amount: Money.parse("12000.00", GBP),
        },
        CHART,
      ),
    ],
    CHART,
  );
}

const OPTIONS = {
  presentation: USD,
  rates: RATES,
  asAt: "2026-12-31",
  period: dateRange("2026-01-01", "2026-12-31"),
};

function rowFor(result: { rows: readonly TranslatedRow[] }, account: string): TranslatedRow {
  const found = result.rows.find((r) => r.account === account);
  if (found === undefined) throw new Error(`No row for ${account}`);
  return found;
}

describe("each line takes the rate its nature calls for", () => {
  const result = translate(books(), OPTIONS);

  it("puts assets at the closing rate", () => {
    const bank = rowFor(result, "1110");
    expect(bank.basis).toBe("closing");
    expect(bank.functional.toString()).toBe("38000.00 GBP");
    // 38,000 at 1.3500.
    expect(bank.presentation.toString()).toBe("51300.00 USD");
  });

  it("puts income and expenses at the average rate for the period", () => {
    expect(rowFor(result, "4200").basis).toBe("average");
    expect(rowFor(result, "5300").basis).toBe("average");
    // Daily average of 1.2500 (1 Jan to 29 Jun), 1.3000 (30 Jun to 30 Dec)
    // and 1.3500 (31 Dec) across 365 days.
    expect(result.averageRate?.toDecimalString(6)).toBe("1.275479");
  });

  it("puts equity at the rate on the day it moved", () => {
    const capital = rowFor(result, "3100");
    expect(capital.basis).toBe("historical");
    expect(capital.functional.toString()).toBe("-10000.00 GBP");
    // Subscribed in January 2025 at 1.2000, and nothing since changes that.
    expect(capital.presentation.toString()).toBe("-12000.00 USD");
    expect(capital.rate).toBeNull();
    expect(capital.effectiveRate?.toDecimalString(4)).toBe("1.2000");
  });

  it("says which rate every row used", () => {
    expect(result.rows.map((r) => `${r.account} ${r.basis}`)).toEqual([
      "1110 closing",
      "3100 historical",
      "4200 average",
      "5300 average",
    ]);
  });
});

describe("the translation adjustment", () => {
  const result = translate(books(), OPTIONS);

  it("is what three different rates leave behind", () => {
    // Assets 51,300.00 debit; capital 12,000.00 credit; revenue and rent at
    // the average rate. The columns do not agree, and the gap is the thing.
    expect(result.translationAdjustment.isZero).toBe(false);
    expect(result.translationAdjustment.currency.code).toBe("USD");
  });

  it("makes the columns agree once it is counted", () => {
    expect(result.balanced).toBe(true);
    expect(result.totalDebit.toString()).toBe(result.totalCredit.toString());
  });

  it("is exactly the residual of the translated rows", () => {
    const residual = result.rows.reduce(
      (total, row) => total.plus(row.presentation),
      Money.zero(USD),
    );
    expect(result.translationAdjustment.toString()).toBe(residual.negated().toString());
  });

  it("comes out where the arithmetic says it should", () => {
    // Bank 51,300.00; capital -12,000.00; revenue -51,019.18; rent 15,305.75.
    const total = result.rows.reduce((sum, row) => sum.plus(row.presentation), Money.zero(USD));
    expect(total.toString()).toBe("3586.57 USD");
    expect(result.translationAdjustment.toString()).toBe("-3586.57 USD");
  });

  it("is named in the rendered statement, not folded into a total", () => {
    const text = renderTranslation(result);
    expect(text).toContain("Translation adjustment");
    expect(text).toContain("an equity item, not a profit");
    expect(text).not.toContain("OUT BY");
  });
});

describe("presenting into the currency the books are already in", () => {
  it("returns the statement unchanged", () => {
    const result = translate(books(), { ...OPTIONS, presentation: GBP });
    expect(result.rows.every((r) => r.basis === "none")).toBe(true);
    expect(result.translationAdjustment.isZero).toBe(true);
    expect(result.balanced).toBe(true);
    expect(rowFor(result, "1110").presentation.toString()).toBe("38000.00 GBP");
  });

  it("does not need a rate at all", () => {
    const result = translate(books(), {
      ...OPTIONS,
      presentation: GBP,
      rates: RateTable.empty(),
    });
    expect(result.closingRate).toBeNull();
    expect(result.averageRate).toBeNull();
  });
});

describe("what translation refuses to guess at", () => {
  it("says which entry it could not price when equity reaches back too far", () => {
    const shortTable = RateTable.of(
      [
        { date: "2026-01-01", base: "GBP", quote: "USD", rate: "1.2500" },
        { date: "2026-06-30", base: "GBP", quote: "USD", rate: "1.3000" },
        { date: "2026-12-31", base: "GBP", quote: "USD", rate: "1.3500" },
      ],
      { maxStaleDays: 400 },
    );
    expect(() => translate(books(), { ...OPTIONS, rates: shortTable })).toThrow(TranslationError);
    try {
      translate(books(), { ...OPTIONS, rates: shortTable });
    } catch (error) {
      expect((error as Error).message).toContain("JE-CAP");
      expect((error as Error).message).toContain("2025-01-02");
      expect((error as Error).message).toContain('equityBasis "closing"');
    }
  });

  it("takes the closing rate for equity when told to, and says so", () => {
    const shortTable = RateTable.of(
      [
        { date: "2026-01-01", base: "GBP", quote: "USD", rate: "1.2500" },
        { date: "2026-06-30", base: "GBP", quote: "USD", rate: "1.3000" },
        { date: "2026-12-31", base: "GBP", quote: "USD", rate: "1.3500" },
      ],
      { maxStaleDays: 400 },
    );
    const result = translate(books(), {
      ...OPTIONS,
      rates: shortTable,
      equityBasis: "closing",
    });
    const capital = rowFor(result, "3100");
    expect(capital.basis).toBe("closing");
    expect(capital.presentation.toString()).toBe("-13500.00 USD");
  });

  it("refuses when there is no closing rate at all", () => {
    expect(() =>
      translate(books(), { ...OPTIONS, rates: RateTable.of([]) }),
    ).toThrow(/No GBP\/USD rate available/);
  });
});

describe("the average method is a choice", () => {
  it("weights weekends differently from the quoted average", () => {
    const daily = translate(books(), OPTIONS);
    const quoted = translate(books(), { ...OPTIONS, averageMethod: "quoted" });
    expect(daily.averageMethod).toBe("daily");
    expect(quoted.averageMethod).toBe("quoted");
    // Three quotes averaged flat, against 365 days weighted by how long each
    // stood: 1.3000 against 1.275411.
    expect(quoted.averageRate?.toDecimalString(6)).toBe("1.300000");
    expect(daily.averageRate?.compare(quoted.averageRate as never)).toBe(-1);
  });

  it("changes the adjustment but never the fact that it balances", () => {
    for (const method of ["daily", "quoted"] as const) {
      const result = translate(books(), { ...OPTIONS, averageMethod: method });
      expect(result.balanced).toBe(true);
    }
  });
});

describe("the rendered statement", () => {
  const text = renderTranslation(translate(books(), OPTIONS));

  it("names both currencies and both rates", () => {
    expect(text).toContain("presented in USD (books kept in GBP)");
    expect(text).toContain("Closing GBP/USD 1.350000");
    expect(text).toContain("daily average 1.275479");
  });

  it("shows the basis beside every line", () => {
    expect(text).toContain("closing");
    expect(text).toContain("historical");
    expect(text).toContain("average");
  });

  it("totals to two equal columns", () => {
    const totals = text.split("\n").find((line) => line.includes("Total")) as string;
    const figures = totals.match(/[\d,]+\.\d\d/g) as string[];
    expect(figures[0]).toBe(figures[1]);
  });
});
