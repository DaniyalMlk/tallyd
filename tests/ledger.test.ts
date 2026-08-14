import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DuplicateEntryError,
  JournalEntry,
  Ledger,
  LedgerIntegrityError,
  balancesByType,
  date,
  dateRange,
  equationResidual,
  renderTrialBalance,
  trialBalance,
} from "../src/ledger/index.js";
import { GBP, Money, USD } from "../src/money/index.js";
import { standardChart } from "../src/accounts/index.js";

const gbp = (text: string) => Money.parse(text, GBP);
const chart = standardChart();

function seeded(): Ledger {
  return Ledger.empty(chart)
    .post(
      JournalEntry.simple({
        id: "1",
        date: "2026-08-01",
        narration: "Share capital",
        debit: "1110",
        credit: "3100",
        amount: gbp("10000.00"),
      }),
    )
    .post(
      JournalEntry.create({
        id: "2",
        date: "2026-08-03",
        narration: "Invoice 1001",
        postings: [
          { account: "1130", amount: gbp("1200.00") },
          { account: "4100", amount: gbp("-1000.00") },
          { account: "2200", amount: gbp("-200.00") },
        ],
        reference: "INV-1001",
      }),
    )
    .post(
      JournalEntry.simple({
        id: "3",
        date: "2026-08-05",
        narration: "Rent",
        debit: "5300",
        credit: "1110",
        amount: gbp("950.00"),
      }),
    )
    .post(
      JournalEntry.simple({
        id: "4",
        date: "2026-08-10",
        narration: "Invoice 1001 paid",
        debit: "1110",
        credit: "1130",
        amount: gbp("1200.00"),
      }),
    );
}

describe("append-only semantics", () => {
  it("returns a new ledger and leaves the original alone", () => {
    const before = Ledger.empty(chart);
    const after = before.post(
      JournalEntry.simple({
        id: "1",
        date: "2026-08-01",
        narration: "Capital",
        debit: "1110",
        credit: "3100",
        amount: gbp("100.00"),
      }),
    );
    expect(before.size).toBe(0);
    expect(after.size).toBe(1);
    expect(before.balanceOf("1110").isZero).toBe(true);
    expect(after.balanceOf("1110").toDecimalString()).toBe("100.00");
  });

  it("rejects a duplicate entry id", () => {
    const ledger = seeded();
    const clash = JournalEntry.simple({
      id: "1",
      date: "2026-08-20",
      narration: "Clash",
      debit: "1110",
      credit: "3100",
      amount: gbp("1.00"),
    });
    expect(() => ledger.post(clash)).toThrow(DuplicateEntryError);
  });

  it("validates accounts against the ledger's chart", () => {
    const ledger = Ledger.empty(chart);
    const bad = JournalEntry.create({
      id: "x",
      date: "2026-08-01",
      narration: "Unknown account",
      postings: [
        { account: "9999", amount: gbp("1.00") },
        { account: "8888", amount: gbp("-1.00") },
      ],
    });
    expect(() => ledger.post(bad)).toThrow(/No such account/);
  });

  it("records through the chart in one step", () => {
    const ledger = Ledger.empty(chart).record({
      id: "r1",
      date: "2026-08-01",
      narration: "Software",
      postings: [
        { account: "5400", amount: gbp("29.00") },
        { account: "1110", amount: gbp("-29.00") },
      ],
    });
    expect(ledger.balanceOf("5400").toDecimalString()).toBe("29.00");
  });

  it("builds from an iterable", () => {
    const entries = seeded().all();
    expect(Ledger.from(entries, chart).size).toBe(4);
  });
});

describe("balances", () => {
  const ledger = seeded();

  it("computes signed balances", () => {
    // 10000 in, 950 rent out, 1200 receipt in
    expect(ledger.balanceOf("1110").toDecimalString()).toBe("10250.00");
    expect(ledger.balanceOf("1130").isZero).toBe(true);
    expect(ledger.balanceOf("4100").toDecimalString()).toBe("-1000.00");
  });

  it("reads income on its normal side", () => {
    expect(ledger.naturalBalanceOf("4100").toDecimalString()).toBe("1000.00");
    expect(ledger.naturalBalanceOf("1110").toDecimalString()).toBe("10250.00");
    expect(ledger.naturalBalanceOf("2200").toDecimalString()).toBe("200.00");
  });

  it("rolls a subtree up to its parent", () => {
    // Bank 10250 + AR 0 = 10250 under Current Assets
    expect(ledger.rolledUpBalanceOf("1100").toDecimalString()).toBe("10250.00");
    expect(ledger.rolledUpBalanceOf("1000").toDecimalString()).toBe("10250.00");
  });

  it("refuses rolled-up balances without a chart", () => {
    const chartless = Ledger.from(seeded().all());
    expect(() => chartless.rolledUpBalanceOf("1100")).toThrow(LedgerIntegrityError);
  });

  it("separates debit and credit totals", () => {
    const bank = ledger.accountBalance("1110");
    expect(bank.debitTotal.toDecimalString()).toBe("11200.00");
    expect(bank.creditTotal.toDecimalString()).toBe("950.00");
    expect(bank.postingCount).toBe(3);
  });

  it("computes a balance as at a date", () => {
    expect(ledger.balanceAsAt("1110", date("2026-08-01")).toDecimalString()).toBe("10000.00");
    expect(ledger.balanceAsAt("1110", date("2026-08-05")).toDecimalString()).toBe("9050.00");
    expect(ledger.balanceAsAt("1110", date("2026-07-31")).isZero).toBe(true);
    expect(ledger.balanceAsAt("1110", date("2026-12-31")).toDecimalString()).toBe("10250.00");
  });

  it("produces a running statement", () => {
    const rows = ledger.statement("1110");
    expect(rows.map((r) => r.running.toDecimalString())).toEqual([
      "10000.00",
      "9050.00",
      "10250.00",
    ]);
  });

  it("keeps currencies apart", () => {
    const mixed = Ledger.empty(chart).post(
      JournalEntry.create({
        id: "fx",
        date: "2026-08-01",
        narration: "Two currencies",
        postings: [
          { account: "1110", amount: gbp("100.00") },
          { account: "4100", amount: gbp("-100.00") },
          { account: "1120", amount: Money.parse("70.00", USD) },
          { account: "4200", amount: Money.parse("-70.00", USD) },
        ],
      }),
    );
    expect(mixed.balanceOf("1110", GBP).toDecimalString()).toBe("100.00");
    expect(mixed.balanceOf("1110", USD).isZero).toBe(true);
    expect(mixed.currenciesUsed()).toEqual(["GBP", "USD"]);
  });

  it("returns zero for an account never posted to", () => {
    expect(ledger.balanceOf("5600").isZero).toBe(true);
    expect(ledger.accountBalance("5600").postingCount).toBe(0);
  });
});

describe("queries", () => {
  const ledger = seeded();

  it("finds entries by id, account, reference and date", () => {
    expect(ledger.entry("2")?.narration).toBe("Invoice 1001");
    expect(ledger.entry("nope")).toBeUndefined();
    expect(ledger.entriesFor("1110").map((e) => e.id)).toEqual(["1", "3", "4"]);
    expect(ledger.byReference("INV-1001").map((e) => e.id)).toEqual(["2"]);
    expect(ledger.entriesOn(date("2026-08-05")).map((e) => e.id)).toEqual(["3"]);
  });

  it("filters by date range inclusively", () => {
    const range = dateRange("2026-08-03", "2026-08-05");
    expect(ledger.entriesIn(range).map((e) => e.id)).toEqual(["2", "3"]);
  });

  it("sorts chronologically, stably", () => {
    const sameDay = ledger
      .post(
        JournalEntry.simple({
          id: "5",
          date: "2026-08-01",
          narration: "Later but same day",
          debit: "5400",
          credit: "1110",
          amount: gbp("10.00"),
        }),
      )
      .chronological()
      .map((e) => e.id);
    expect(sameDay).toEqual(["1", "5", "2", "3", "4"]);
  });

  it("excludes reversed pairs from live()", () => {
    const reversed = ledger.reverse("3", { id: "3r", date: "2026-08-12" });
    const live = reversed.live().map((e) => e.id);
    expect(live).not.toContain("3");
    expect(live).not.toContain("3r");
    expect(live).toContain("2");
  });

  it("cannot reverse an unknown entry", () => {
    expect(() => ledger.reverse("nope", { id: "x", date: "2026-08-12" })).toThrow(
      LedgerIntegrityError,
    );
  });

  it("nets a reversal back to the prior balance", () => {
    const before = ledger.balanceOf("5300");
    const after = ledger.reverse("3", { id: "3r", date: "2026-08-12" });
    expect(before.toDecimalString()).toBe("950.00");
    expect(after.balanceOf("5300").isZero).toBe(true);
  });
});

describe("integrity", () => {
  it("verifies a healthy ledger", () => {
    expect(() => seeded().verify()).not.toThrow();
    expect(seeded().isBalanced).toBe(true);
    expect(Ledger.empty(chart).isBalanced).toBe(true);
  });

  it("agrees with a from-scratch replay", () => {
    const ledger = seeded();
    const replayed = Ledger.from(ledger.all(), chart);
    for (const account of ledger.activeAccounts()) {
      expect(replayed.balanceOf(account).equals(ledger.balanceOf(account))).toBe(true);
    }
  });

  it("stays balanced under any sequence of valid entries", () => {
    const accountArb = fc.constantFrom("1110", "1120", "1130", "4100", "5300", "5400");
    const entryArb = fc
      .record({
        debit: accountArb,
        credit: accountArb,
        minor: fc.bigInt({ min: 1n, max: 10n ** 9n }),
        day: fc.integer({ min: 1, max: 28 }),
      })
      .filter((x) => x.debit !== x.credit);

    fc.assert(
      fc.property(fc.array(entryArb, { minLength: 0, maxLength: 40 }), (specs) => {
        let ledger = Ledger.empty(chart);
        specs.forEach((spec, i) => {
          ledger = ledger.post(
            JournalEntry.simple({
              id: `e${i}`,
              date: `2026-08-${String(spec.day).padStart(2, "0")}`,
              narration: `Entry ${i}`,
              debit: spec.debit,
              credit: spec.credit,
              amount: Money.ofMinor(spec.minor, GBP),
            }),
          );
        });
        expect(() => ledger.verify()).not.toThrow();
        const total = ledger
          .activeAccounts()
          .map((a) => ledger.balanceOf(a))
          .reduce((a, b) => a.plus(b), Money.zero(GBP));
        expect(total.isZero).toBe(true);
      }),
      { numRuns: 120 },
    );
  });

  it("keeps the balance index in step with as-at replay", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            minor: fc.bigInt({ min: 1n, max: 10n ** 6n }),
            day: fc.integer({ min: 1, max: 28 }),
          }),
          { minLength: 1, maxLength: 25 },
        ),
        (specs) => {
          let ledger = Ledger.empty(chart);
          specs.forEach((spec, i) => {
            ledger = ledger.post(
              JournalEntry.simple({
                id: `e${i}`,
                date: `2026-08-${String(spec.day).padStart(2, "0")}`,
                narration: `Entry ${i}`,
                debit: "1110",
                credit: "4100",
                amount: Money.ofMinor(spec.minor, GBP),
              }),
            );
          });
          const asAtEnd = ledger.balanceAsAt("1110", date("2026-12-31"));
          expect(asAtEnd.equals(ledger.balanceOf("1110"))).toBe(true);
        },
      ),
      { numRuns: 80 },
    );
  });
});

describe("trial balance", () => {
  const ledger = seeded();

  it("balances", () => {
    const tb = trialBalance(ledger);
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit.equals(tb.totalCredit)).toBe(true);
    expect(tb.totalDebit.toDecimalString()).toBe("11200.00");
  });

  it("puts each account in the right column", () => {
    const tb = trialBalance(ledger);
    const bank = tb.rows.find((r) => r.account === "1110");
    const income = tb.rows.find((r) => r.account === "4100");
    expect(bank?.debit.toDecimalString()).toBe("10250.00");
    expect(bank?.credit.isZero).toBe(true);
    expect(income?.credit.toDecimalString()).toBe("1000.00");
    expect(income?.debit.isZero).toBe(true);
  });

  it("omits zero-balance accounts unless asked", () => {
    const without = trialBalance(ledger);
    const with_ = trialBalance(ledger, { includeZero: true });
    expect(without.rows.map((r) => r.account)).not.toContain("1130");
    expect(with_.rows.map((r) => r.account)).toContain("1130");
  });

  it("restates as at an earlier date", () => {
    const tb = trialBalance(ledger, { asAt: date("2026-08-03") });
    expect(tb.balanced).toBe(true);
    const bank = tb.rows.find((r) => r.account === "1110");
    expect(bank?.debit.toDecimalString()).toBe("10000.00");
    const ar = tb.rows.find((r) => r.account === "1130");
    expect(ar?.debit.toDecimalString()).toBe("1200.00");
  });

  it("names accounts from the chart", () => {
    const tb = trialBalance(ledger);
    expect(tb.rows.find((r) => r.account === "5300")?.name).toBe("Rent");
    expect(tb.rows.find((r) => r.account === "5300")?.type).toBe("expense");
  });

  it("totals by account type on the natural side", () => {
    const totals = balancesByType(ledger);
    expect(totals.get("asset")?.toDecimalString()).toBe("10250.00");
    expect(totals.get("income")?.toDecimalString()).toBe("1000.00");
    expect(totals.get("expense")?.toDecimalString()).toBe("950.00");
    expect(totals.get("equity")?.toDecimalString()).toBe("10000.00");
    expect(totals.get("liability")?.toDecimalString()).toBe("200.00");
  });

  it("satisfies the accounting equation", () => {
    expect(equationResidual(ledger).isZero).toBe(true);
  });

  it("satisfies the equation after any random sequence", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            debit: fc.constantFrom("1110", "1130", "5300", "5400"),
            credit: fc.constantFrom("4100", "2100", "3100"),
            minor: fc.bigInt({ min: 1n, max: 10n ** 8n }),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (specs) => {
          let ledger = Ledger.empty(chart);
          specs.forEach((spec, i) => {
            ledger = ledger.post(
              JournalEntry.simple({
                id: `e${i}`,
                date: "2026-08-14",
                narration: `Entry ${i}`,
                debit: spec.debit,
                credit: spec.credit,
                amount: Money.ofMinor(spec.minor, GBP),
              }),
            );
          });
          expect(trialBalance(ledger).balanced).toBe(true);
          expect(equationResidual(ledger).isZero).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("renders a readable report", () => {
    const rendered = renderTrialBalance(trialBalance(ledger));
    expect(rendered).toContain("Trial balance (GBP)");
    expect(rendered).toContain("Bank");
    expect(rendered).toContain("11200.00");
    expect(rendered).not.toContain("OUT BY");
  });

  it("handles an empty ledger", () => {
    const tb = trialBalance(Ledger.empty(chart));
    expect(tb.rows).toEqual([]);
    expect(tb.balanced).toBe(true);
  });
});
