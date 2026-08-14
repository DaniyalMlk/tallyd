import { describe, it, expect } from "vitest";
import { Money, GBP, USD, sumMoney } from "../src/money/index.js";
import { JournalEntry, UnbalancedEntryError, Ledger, trialBalance, equationResidual } from "../src/ledger/index.js";

let seed = 0x51ed7ee;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const randInt = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

const ACCTS = ["1000", "1100", "2000", "3000", "4000", "5000"];

describe("no sequence of operations can unbalance the ledger", () => {
  it("rejects every randomly-unbalanced entry (5k attempts)", () => {
    let rejected = 0;
    for (let i = 0; i < 5000; i++) {
      const n = randInt(2, 5);
      const amounts: bigint[] = [];
      for (let k = 0; k < n - 1; k++) amounts.push(BigInt(randInt(-10000, 10000) || 1));
      // deliberately break the balance by a nonzero delta
      const delta = BigInt(randInt(1, 500)) * (rnd() < 0.5 ? -1n : 1n);
      amounts.push(-amounts.reduce((a, b) => a + b, 0n) + delta);
      if (amounts.some((a) => a === 0n)) continue;
      expect(() =>
        JournalEntry.create({
          id: `e${i}`, date: "2026-01-15", narration: "adversarial",
          postings: amounts.map((a) => ({ account: ACCTS[randInt(0, 5)], amount: Money.ofMinor(a, GBP) })),
        }),
      ).toThrow(UnbalancedEntryError);
      rejected++;
    }
    expect(rejected).toBeGreaterThan(4000);
  });

  it("accepts balanced entries and the ledger's equation residual stays zero (2k entries)", () => {
    let ledger = Ledger.empty();
    for (let i = 0; i < 2000; i++) {
      const n = randInt(2, 4);
      const amounts: bigint[] = [];
      for (let k = 0; k < n - 1; k++) amounts.push(BigInt(randInt(-10000, 10000) || 7));
      amounts.push(-amounts.reduce((a, b) => a + b, 0n));
      if (amounts.some((a) => a === 0n)) continue;
      const e = JournalEntry.create({
        id: `ok${i}`, date: "2026-01-15", narration: "balanced",
        postings: amounts.map((a) => ({ account: ACCTS[randInt(0, 5)], amount: Money.ofMinor(a, GBP) })),
      });
      ledger = ledger.post(e);
      // after EVERY post, all postings in the ledger must still sum to zero
      const all = ledger.entries.flatMap((x) => x.postings.map((p) => p.amount));
      if (all.length) expect(sumMoney(all, GBP).minorUnits).toBe(0n);
    }
    expect(ledger.entries.length).toBeGreaterThan(1500);
  });

  it("mixed-currency entries must balance per currency, not in aggregate", () => {
    // +100 GBP and -100 USD nets to "zero" only if you ignore currency. Must throw.
    expect(() =>
      JournalEntry.create({
        id: "fx", date: "2026-01-15", narration: "cross-currency",
        postings: [
          { account: "1000", amount: Money.ofMinor(10000n, GBP) },
          { account: "2000", amount: Money.ofMinor(-10000n, USD) },
        ],
      }),
    ).toThrow(UnbalancedEntryError);
  });

  it("a single-posting entry is rejected even if it is zero-sum", () => {
    expect(() =>
      JournalEntry.create({
        id: "one", date: "2026-01-15", narration: "single",
        postings: [{ account: "1000", amount: Money.ofMinor(0n, GBP) }],
      }),
    ).toThrow();
  });
});
