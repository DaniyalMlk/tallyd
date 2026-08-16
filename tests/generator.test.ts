import { describe, expect, it } from "vitest";
import { generateBooks, statementCsv } from "../src/demo/generator.js";
import { bankView } from "../src/reconcile/bankView.js";
import { trialBalance } from "../src/ledger/trialBalance.js";
import { importStatement } from "../src/statement/index.js";
import { GBP, USD } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";

const small = () => generateBooks({ seed: 7, months: 2, invoicesPerMonth: 6 });

describe("the generator is deterministic", () => {
  it("produces an identical statement for the same seed", () => {
    const a = generateBooks({ seed: 3, months: 2, invoicesPerMonth: 5 });
    const b = generateBooks({ seed: 3, months: 2, invoicesPerMonth: 5 });
    expect(statementCsv(a)).toBe(statementCsv(b));
  });

  it("produces an identical ledger for the same seed", () => {
    const a = generateBooks({ seed: 3, months: 2, invoicesPerMonth: 5 });
    const b = generateBooks({ seed: 3, months: 2, invoicesPerMonth: 5 });
    const ids = (g: typeof a) => bankView(g.ledger, g.bankAccount).map((line) => `${line.id}|${line.date}|${line.amount.toDecimalString()}`);
    expect(ids(a)).toEqual(ids(b));
  });

  it("produces different books for a different seed", () => {
    const a = generateBooks({ seed: 3, months: 2, invoicesPerMonth: 5 });
    const b = generateBooks({ seed: 4, months: 2, invoicesPerMonth: 5 });
    expect(statementCsv(a)).not.toBe(statementCsv(b));
  });

  it("produces identical ground truth for the same seed", () => {
    const a = generateBooks({ seed: 11, months: 1, invoicesPerMonth: 8 });
    const b = generateBooks({ seed: 11, months: 1, invoicesPerMonth: 8 });
    expect(a.truth).toEqual(b.truth);
  });
});

describe("the generated books are real books", () => {
  it("balances", () => {
    const generated = small();
    expect(() => generated.ledger.verify()).not.toThrow();
  });

  it("has a trial balance that agrees", () => {
    const generated = small();
    const balance = trialBalance(generated.ledger);
    expect(balance.balanced).toBe(true);
    expect(balance.difference.isZero).toBe(true);
    expect(balance.totalDebit.toDecimalString()).toBe(balance.totalCredit.toDecimalString());
  });

  it("never overdraws the bank account", () => {
    const generated = generateBooks({ seed: 5, months: 3, invoicesPerMonth: 10 });
    const closing = generated.ledger.balanceOf(generated.bankAccount, GBP);
    expect(closing.isNegative).toBe(false);
  });

  it("scales with the months asked for", () => {
    const one = generateBooks({ seed: 2, months: 1, invoicesPerMonth: 8 });
    const four = generateBooks({ seed: 2, months: 4, invoicesPerMonth: 8 });
    expect(four.summary.entries).toBeGreaterThan(one.summary.entries * 3);
  });

  it("scales with the invoices asked for", () => {
    const light = generateBooks({ seed: 2, months: 2, invoicesPerMonth: 4 });
    const heavy = generateBooks({ seed: 2, months: 2, invoicesPerMonth: 20 });
    expect(heavy.summary.statementLines).toBeGreaterThan(light.summary.statementLines * 2);
  });

  it("honours a non-default currency", () => {
    const generated = generateBooks({ seed: 2, months: 1, invoicesPerMonth: 4, currency: USD });
    expect(generated.currency.code).toBe("USD");
    for (const line of generated.statement) expect(line.amount.currency.code).toBe("USD");
  });

  it("clamps a nonsense size rather than looping forever", () => {
    const generated = generateBooks({ seed: 2, months: 0, invoicesPerMonth: 0 });
    expect(generated.summary.statementLines).toBeGreaterThan(0);
  });

  it("starts where it is told to", () => {
    const generated = generateBooks({ seed: 2, months: 1, invoicesPerMonth: 4, start: "2027-03-01" });
    expect(generated.from).toBe("2027-03-01");
    for (const line of generated.statement) expect(line.date >= "2027-03-01").toBe(true);
  });
});

describe("the statement is the bank's version, not a copy of the ledger", () => {
  it("is ordered by date", () => {
    const generated = small();
    const dates = generated.statement.map((line) => line.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it("carries a running balance that agrees with its own lines", () => {
    const generated = small();
    let running = Money.zero(generated.currency);
    for (const line of generated.statement) {
      running = running.plus(line.amount);
      expect(line.balance?.toDecimalString()).toBe(running.toDecimalString());
    }
  });

  it("contains lines the books never saw", () => {
    const generated = generateBooks({ seed: 9, months: 3, invoicesPerMonth: 12, bankOnlyRate: 0.08 });
    expect(generated.summary.bankOnly).toBeGreaterThan(0);
    const unexplained = generated.statement.filter(
      (line) => !generated.truth.some((link) => link.statementId === line.id),
    );
    expect(unexplained.length).toBe(generated.summary.bankOnly);
  });

  it("leaves some ledger movements off the statement", () => {
    const generated = generateBooks({ seed: 9, months: 3, invoicesPerMonth: 12, outstandingRate: 0.2 });
    expect(generated.summary.ledgerOnly).toBeGreaterThan(0);
  });

  it("adds nothing bank-only when the rate is zero", () => {
    const generated = generateBooks({ seed: 9, months: 2, invoicesPerMonth: 8, bankOnlyRate: 0 });
    expect(generated.summary.bankOnly).toBe(0);
  });

  it("drops nothing when the outstanding rate is zero", () => {
    const generated = generateBooks({ seed: 9, months: 2, invoicesPerMonth: 8, outstandingRate: 0 });
    expect(generated.summary.ledgerOnly).toBe(0);
  });

  it("writes descriptors in bank style, not ledger style", () => {
    const generated = small();
    const shouted = generated.statement.filter((line) => line.description === line.description.toUpperCase());
    expect(shouted.length).toBe(generated.statement.length);
  });

  it("produces batch lines that stand for several postings", () => {
    const generated = generateBooks({ seed: 13, months: 3, invoicesPerMonth: 14 });
    const groups = generated.truth.filter((link) => link.bookIds.length > 1);
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.length).toBe(generated.summary.grouped);
  });
});

describe("ground truth points at things that exist", () => {
  it("names a real statement line and real book lines", () => {
    const generated = generateBooks({ seed: 21, months: 2, invoicesPerMonth: 9 });
    const statementIds = new Set(generated.statement.map((line) => line.id));
    const bookIds = new Set(bankView(generated.ledger, generated.bankAccount).map((line) => line.id));

    for (const link of generated.truth) {
      expect(statementIds.has(link.statementId)).toBe(true);
      expect(link.bookIds.length).toBeGreaterThan(0);
      for (const id of link.bookIds) expect(bookIds.has(id)).toBe(true);
    }
  });

  it("claims each book line at most once", () => {
    const generated = generateBooks({ seed: 21, months: 2, invoicesPerMonth: 9 });
    const claimed = generated.truth.flatMap((link) => link.bookIds);
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it("claims each statement line at most once", () => {
    const generated = generateBooks({ seed: 21, months: 2, invoicesPerMonth: 9 });
    const claimed = generated.truth.map((link) => link.statementId);
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it("links amounts that add up, allowing for the fee on a settlement", () => {
    const generated = generateBooks({ seed: 23, months: 2, invoicesPerMonth: 8 });
    const books = new Map(bankView(generated.ledger, generated.bankAccount).map((line) => [line.id, line]));
    const lines = new Map(generated.statement.map((line) => [line.id, line]));

    for (const link of generated.truth) {
      const line = lines.get(link.statementId);
      if (line === undefined) throw new Error("missing line");
      const total = link.bookIds.reduce(
        (sum, id) => sum + (books.get(id)?.amount.minorUnits ?? 0n),
        0n,
      );
      expect(total).toBe(line.amount.minorUnits);
    }
  });

  it("accounts for every ledger movement either on the statement or as outstanding", () => {
    const generated = generateBooks({ seed: 23, months: 2, invoicesPerMonth: 8 });
    const books = bankView(generated.ledger, generated.bankAccount);
    const claimed = new Set(generated.truth.flatMap((link) => link.bookIds));
    const unclaimed = books.filter((line) => !claimed.has(line.id));
    expect(unclaimed.length).toBe(generated.summary.ledgerOnly);
  });
});

describe("the CSV round-trips through the statement reader", () => {
  it("reads back the same lines", () => {
    const generated = generateBooks({ seed: 31, months: 2, invoicesPerMonth: 7 });
    const imported = importStatement(statementCsv(generated), { currency: GBP });

    expect(imported.lines.length).toBe(generated.statement.length);
    for (let i = 0; i < imported.lines.length; i++) {
      const read = imported.lines[i];
      const original = generated.statement[i];
      if (read === undefined || original === undefined) throw new Error("length mismatch");
      expect(read.date).toBe(original.date);
      expect(read.amount.toDecimalString()).toBe(original.amount.toDecimalString());
      expect(read.description).toBe(original.description);
    }
  });

  it("quotes a description containing a comma", () => {
    const generated = generateBooks({ seed: 31, months: 1, invoicesPerMonth: 4 });
    const csv = statementCsv(generated);
    for (const row of csv.split("\n").slice(4)) {
      if (row.trim() === "") continue;
      const commas = row.split(",").length - 1;
      expect(commas).toBeGreaterThanOrEqual(5);
    }
  });

  it("writes dates in the bank's day-first format", () => {
    const generated = generateBooks({ seed: 31, months: 1, invoicesPerMonth: 4, start: "2026-02-03" });
    expect(statementCsv(generated)).toContain("03/02/2026");
  });

  it("keeps paid-in and paid-out in separate columns", () => {
    const generated = generateBooks({ seed: 31, months: 1, invoicesPerMonth: 5 });
    const rows = statementCsv(generated).split("\n").slice(4).filter((row) => row.trim() !== "");
    for (const row of rows) {
      const fields = row.split(",");
      const paidOut = fields[fields.length - 3];
      const paidIn = fields[fields.length - 2];
      expect(paidOut === "" || paidIn === "").toBe(true);
    }
  });
});
