import { describe, expect, it } from "vitest";
import { GBP, Money } from "../src/money/index.js";
import { date } from "../src/ledger/date.js";
import { Ledger } from "../src/ledger/ledger.js";
import { standardChart } from "../src/accounts/standard.js";
import { trialBalance } from "../src/ledger/trialBalance.js";
import { statementLine, type StatementLine } from "../src/statement/line.js";
import { importCsv } from "../src/statement/import.js";
import { bankView } from "../src/reconcile/bankView.js";
import { reconcile } from "../src/reconcile/matcher.js";
import { MatchMemory } from "../src/reconcile/memory.js";
import { demoLedger } from "../src/demo/month.js";
import { DEMO_BANK_CSV } from "../src/demo/statement.js";
import {
  linesNeedingEntries,
  PostingRuleError,
  applyProposals,
  impliedEntryId,
  parseRules,
  proposeEntries,
  renderProposals,
  standardRules,
  summariseProposals,
  type PostingRule,
  type Proposal,
} from "../src/reconcile/posting.js";

let row = 0;
function line(description: string, amount: string, on = "2026-03-31"): StatementLine {
  row += 1;
  return statementLine({
    id: `BANK-${row}`,
    date: date(on),
    description,
    amount: Money.parse(amount, GBP),
    sourceRow: row,
  });
}

const chart = standardChart("GBP");

/** A ledger with an opening balance, so the bank account is a real account. */
function seedLedger(): Ledger {
  return Ledger.empty(chart).record({
    id: "JE-OPEN",
    date: "2026-01-01",
    narration: "Share capital introduced",
    postings: [
      { account: "1110", amount: Money.parse("40000.00", GBP) },
      { account: "3100", amount: Money.parse("-40000.00", GBP) },
    ],
  });
}

const propose = (lines: readonly StatementLine[], extra: Record<string, unknown> = {}) =>
  proposeEntries(lines, { account: "1110", chart, ...extra });

const outcomes = (proposals: readonly Proposal[]) => proposals.map((p) => p.outcome);

describe("classification", () => {
  const cases: readonly [string, string, string][] = [
    ["ACCOUNT MAINTENANCE FEE", "-1.64", "5800"],
    ["BANK CHARGE MONTHLY", "-8.00", "5800"],
    ["GROSS INTEREST PAID", "4.12", "4300"],
    ["INTEREST ON OVERDRAFT", "-19.40", "5800"],
    ["DD PROPERTY RENT", "-1850.00", "5300"],
    ["BACS PAYROLL", "-5390.00", "5200"],
    ["HMRC PAYE NIC 4471", "-2210.00", "2300"],
    ["HMRC VAT RETURN", "-6120.00", "2200"],
    ["ADOBE SUBSCRIPTION", "-49.99", "5400"],
    ["TRAINLINE 88213", "-142.60", "5600"],
    ["SOLICITOR RETAINER", "-900.00", "5700"],
    ["OWNER DRAWINGS", "-2000.00", "3300"],
    ["STRIPE FEE JUNE", "-42.11", "5500"],
  ];

  it.each(cases)("%s (%s) lands in %s", (description, amount, account) => {
    const [proposal] = propose([line(description, amount)]);
    expect(proposal?.outcome).toBe("book");
    expect(proposal?.account).toBe(account);
  });

  it("tells interest received from interest paid by direction alone", () => {
    const received = propose([line("INTEREST", "4.12")])[0];
    const paid = propose([line("INTEREST", "-4.12")])[0];

    expect(received?.account).toBe("4300");
    expect(paid?.account).toBe("5800");
  });

  it("does not treat an HMRC PAYE payment as net pay", () => {
    const [proposal] = propose([line("HMRC PAYE 123456", "-2210.00")]);
    expect(proposal?.rule?.id).toBe("payroll-taxes");
  });

  it("skips an opening balance line rather than booking a receipt", () => {
    const [proposal] = propose([line("BALANCE BROUGHT FORWARD", "40000.00", "2026-01-01")]);
    expect(proposal?.outcome).toBe("skip");
    expect(proposal?.entry).toBeNull();
    expect(proposal?.reason).toContain("not a transaction");
  });

  it("leaves a line no rule matches unclassified rather than guessing", () => {
    const [proposal] = propose([line("FPO WHOEVER THIS IS 8811", "-412.00")]);
    expect(proposal?.outcome).toBe("unclassified");
    expect(proposal?.account).toBeNull();
    expect(proposal?.entry).toBeNull();
  });

  it("books the unclassified remainder only when an account is named for it", () => {
    const [proposal] = propose([line("FPO WHOEVER THIS IS 8811", "-412.00")], {
      suspenseAccount: "1120",
    });
    expect(proposal?.outcome).toBe("book");
    expect(proposal?.account).toBe("1120");
    expect(proposal?.reason).toContain("suspense");
  });
});

describe("the entry a line implies", () => {
  it("balances", () => {
    const [proposal] = propose([line("ACCOUNT MAINTENANCE FEE", "-1.64")]);
    const entry = proposal?.entry;
    expect(entry).not.toBeNull();
    // `total` is the debit side; the balancing invariant is what makes the
    // credit side its mirror.
    expect(entry?.total("GBP").toDecimalString()).toBe("1.64");
    expect(entry?.postings.reduce((sum, p) => sum + p.amount.minorUnits, 0n)).toBe(0n);
  });

  it("credits the bank and debits the expense for money going out", () => {
    const [proposal] = propose([line("ACCOUNT MAINTENANCE FEE", "-1.64")]);
    const entry = proposal?.entry;
    expect(entry?.amountFor("1110").toDecimalString()).toBe("-1.64");
    expect(entry?.amountFor("5800").toDecimalString()).toBe("1.64");
  });

  it("debits the bank and credits income for money coming in", () => {
    const [proposal] = propose([line("GROSS INTEREST", "4.12")]);
    expect(proposal?.entry?.amountFor("1110").toDecimalString()).toBe("4.12");
    expect(proposal?.entry?.amountFor("4300").toDecimalString()).toBe("-4.12");
  });

  it("flips for a credit-card control account, where money in is a credit", () => {
    const [proposal] = propose([line("ADOBE SUBSCRIPTION", "-49.99")], {
      account: "2400",
      inflowSign: -1,
    });
    expect(proposal?.entry?.amountFor("2400").toDecimalString()).toBe("49.99");
    expect(proposal?.entry?.amountFor("5400").toDecimalString()).toBe("-49.99");
  });

  it("takes the date from the statement line", () => {
    const [proposal] = propose([line("BANK CHARGE", "-8.00", "2026-02-14")]);
    expect(proposal?.entry?.date).toBe("2026-02-14");
  });

  it("narrates from the rule and keeps the bank's own words as the memo", () => {
    const [proposal] = propose([line("ACCOUNT MAINTENANCE FEE", "-1.64")]);
    expect(proposal?.entry?.narration).toBe("Bank charges");
    expect(proposal?.entry?.postings[0]?.memo).toBe("ACCOUNT MAINTENANCE FEE");
  });

  it("tags the entry so an import can be found again", () => {
    const [proposal] = propose([line("BANK CHARGE", "-8.00")]);
    expect(proposal?.entry?.tags).toContain("bank-import");
  });

  it("refuses an account the chart does not have", () => {
    const rules: PostingRule[] = [
      { id: "nope", describe: "x", match: { any: ["CHARGE"] }, account: "8888" },
    ];
    expect(() => propose([line("BANK CHARGE", "-8.00")], { rules })).toThrow();
  });
});

describe("posting the same statement twice", () => {
  it("gives a line the same entry id every time", () => {
    const one = line("ACCOUNT MAINTENANCE FEE", "-1.64", "2026-02-03");
    const again = line("ACCOUNT MAINTENANCE FEE", "-1.64", "2026-02-03");
    expect(impliedEntryId(one)).toBe(impliedEntryId(again));
  });

  it("gives different lines different ids", () => {
    expect(impliedEntryId(line("BANK CHARGE", "-8.00"))).not.toBe(
      impliedEntryId(line("BANK CHARGE", "-9.00")),
    );
  });

  it("reports the second run as already booked and posts nothing", () => {
    const lines = [line("ACCOUNT MAINTENANCE FEE", "-1.64"), line("GROSS INTEREST", "4.12")];
    const first = propose(lines, { ledger: seedLedger() });
    const ledger = applyProposals(seedLedger(), first);

    const second = propose(lines, { ledger });

    expect(outcomes(second)).toEqual(["already-booked", "already-booked"]);
    expect(applyProposals(ledger, second).size).toBe(ledger.size);
  });

  it("leaves the balances identical after a repeat", () => {
    const lines = [line("BANK CHARGE", "-8.00"), line("DD PROPERTY RENT", "-1850.00")];
    const once = applyProposals(seedLedger(), propose(lines, { ledger: seedLedger() }));
    const twice = applyProposals(once, propose(lines, { ledger: once }));

    expect(twice.balanceOf("1110").toDecimalString()).toBe(once.balanceOf("1110").toDecimalString());
  });

  it("still books a genuinely new line alongside ones already there", () => {
    const first = [line("BANK CHARGE", "-8.00")];
    const ledger = applyProposals(seedLedger(), propose(first, { ledger: seedLedger() }));

    const second = propose([...first, line("GROSS INTEREST", "4.12")], { ledger });
    expect(outcomes(second)).toEqual(["already-booked", "book"]);
  });
});

describe("applying them", () => {
  it("keeps the ledger balanced", () => {
    const proposals = propose(
      [
        line("ACCOUNT MAINTENANCE FEE", "-1.64"),
        line("GROSS INTEREST", "4.12"),
        line("DD PROPERTY RENT", "-1850.00"),
      ],
      { ledger: seedLedger() },
    );
    const after = applyProposals(seedLedger(), proposals);

    expect(() => after.verify()).not.toThrow();
    expect(trialBalance(after).balanced).toBe(true);
  });

  it("moves the bank balance by exactly the lines it booked", () => {
    const before = seedLedger();
    const proposals = propose(
      [line("ACCOUNT MAINTENANCE FEE", "-1.64"), line("GROSS INTEREST", "4.12")],
      { ledger: before },
    );
    const after = applyProposals(before, proposals);

    const moved = after.balanceOf("1110").minus(before.balanceOf("1110"));
    expect(moved.toDecimalString()).toBe("2.48");
  });

  it("posts nothing for skipped, unclassified or already-booked lines", () => {
    const before = seedLedger();
    const proposals = propose([
      line("BALANCE BROUGHT FORWARD", "40000.00", "2026-01-01"),
      line("FPO MYSTERY 9911", "-12.00"),
    ]);
    expect(applyProposals(before, proposals).size).toBe(before.size);
  });
});

describe("summarising", () => {
  const proposals = propose([
    line("ACCOUNT MAINTENANCE FEE", "-1.64"),
    line("BANK CHARGE", "-8.00"),
    line("GROSS INTEREST", "4.12"),
    line("BALANCE BROUGHT FORWARD", "40000.00", "2026-01-01"),
    line("FPO MYSTERY 9911", "-12.00"),
  ]);
  const summary = summariseProposals(proposals, GBP);

  it("counts each outcome", () => {
    expect(summary).toMatchObject({ total: 5, booked: 3, skipped: 1, unclassified: 1, alreadyBooked: 0 });
  });

  it("nets only what it would book", () => {
    expect(summary.net.toDecimalString()).toBe("-5.52");
  });

  it("groups by account, most material first", () => {
    expect(summary.byAccount[0]?.account).toBe("5800");
    expect(summary.byAccount[0]?.count).toBe(2);
    expect(summary.byAccount[0]?.amount.toDecimalString()).toBe("-9.64");
  });

  it("renders a table a person can read", () => {
    const text = renderProposals(proposals, summary);
    expect(text).toContain("5800");
    expect(text).toContain("unclassified");
    expect(text).toContain("3 to book, 1 skipped");
  });

  it("says so plainly when there is nothing to do", () => {
    expect(renderProposals([], summariseProposals([], GBP))).toContain("Nothing on the statement");
  });
});

describe("custom rules", () => {
  it("reads a rules file", () => {
    const rules = parseRules(
      JSON.stringify([
        { id: "gym", describe: "the company gym membership", match: { any: ["PUREGYM"] }, account: "5700" },
      ]),
    );
    const [proposal] = propose([line("DD PUREGYM 4471", "-29.99")], { rules });

    expect(proposal?.rule?.id).toBe("gym");
    expect(proposal?.account).toBe("5700");
  });

  it("matches on a regex when tokens are not enough", () => {
    const rules = parseRules(
      JSON.stringify([
        { id: "utilities", describe: "utilities", match: { regex: "^(EDF|OCTOPUS|BRITISH GAS)" }, account: "5300" },
      ]),
    );
    expect(propose([line("OCTOPUS ENERGY DD", "-180.00")], { rules })[0]?.rule?.id).toBe("utilities");
    expect(propose([line("PAID OCTOPUS LATER", "-180.00")], { rules })[0]?.outcome).toBe("unclassified");
  });

  it("honours a none clause", () => {
    const rules = parseRules(
      JSON.stringify([
        { id: "fees", describe: "fees", match: { any: ["FEE"], none: ["REFUND"] }, account: "5800" },
      ]),
    );
    expect(propose([line("CARD FEE", "-3.00")], { rules })[0]?.outcome).toBe("book");
    expect(propose([line("CARD FEE REFUND", "3.00")], { rules })[0]?.outcome).toBe("unclassified");
  });

  it("takes the first rule that fires, so order decides", () => {
    const rules = parseRules(
      JSON.stringify([
        { id: "first", describe: "first", match: { any: ["FEE"] }, account: "5800" },
        { id: "second", describe: "second", match: { any: ["FEE"] }, account: "5500" },
      ]),
    );
    expect(propose([line("CARD FEE", "-3.00")], { rules })[0]?.rule?.id).toBe("first");
  });

  const badRules: readonly [string, string, string][] = [
    ["not JSON", "{oh dear", "not valid JSON"],
    ["not an array", "{}", "must be a JSON array"],
    ["a null rule", "[null]", "Rule 0 must be an object"],
    ["a rule with no id", '[{"match":{"any":["X"]},"account":"5800"}]', "needs an id"],
    ["a booking rule with no account", '[{"id":"a","match":{"any":["X"]}}]', "names no account"],
    ["a nonsense action", '[{"id":"a","action":"burn","match":{"any":["X"]}}]', "neither book nor skip"],
    ["a nonsense direction", '[{"id":"a","direction":"sideways","match":{"any":["X"]},"account":"5800"}]', "not in, out or either"],
    ["no match object", '[{"id":"a","account":"5800"}]', "needs a match object"],
    ["a match clause that is not strings", '[{"id":"a","match":{"any":[1]},"account":"5800"}]', "list of strings"],
    ["a regex that is not a string", '[{"id":"a","match":{"regex":7},"account":"5800"}]', "not a string"],
  ];

  it.each(badRules)("rejects %s", (_label, text, message) => {
    expect(() => parseRules(text)).toThrow(PostingRuleError);
    expect(() => parseRules(text)).toThrow(new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("refuses a rule that matches on nothing at all", () => {
    const rules: PostingRule[] = [
      { id: "empty", describe: "x", match: { none: ["ZZZ"] }, account: "5800" },
    ];
    expect(() => propose([line("ANYTHING", "-1.00")], { rules })).toThrow(/matches on nothing/);
  });

  it("refuses an unusable regex at the point it is used", () => {
    const rules: PostingRule[] = [
      { id: "bad", describe: "x", match: { regex: "([" }, account: "5800" },
    ];
    expect(() => propose([line("ANYTHING", "-1.00")], { rules })).toThrow(PostingRuleError);
  });

  it("keeps the standard rules frozen against edits", () => {
    expect(Object.isFrozen(standardRules())).toBe(true);
  });
});


describe("which lines still need booking", () => {
  const imported = importCsv(DEMO_BANK_CSV, { currency: GBP, idPrefix: "BANK" });
  const books = bankView(demoLedger(), "1110");
  const result = reconcile(books, imported.lines);

  const rejectAll = (which: number): MatchMemory => {
    const suggestion = result.suggested[which];
    if (suggestion === undefined) throw new Error("no such suggestion");
    return MatchMemory.from(
      suggestion.statement.flatMap((statement) =>
        suggestion.book.map((book) => ({
          statementDescription: statement.description,
          bookDescription: book.description,
          accepted: false,
          on: date("2026-09-30"),
        })),
      ),
    );
  };

  it("starts from the lines nothing matched", () => {
    expect(linesNeedingEntries(result)).toEqual(
      [...result.unmatchedStatement].sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? -1 : 1)),
    );
  });

  it("leaves an undecided suggestion alone", () => {
    expect(result.suggested.length).toBeGreaterThan(0);
    expect(linesNeedingEntries(result, MatchMemory.empty())).toHaveLength(
      result.unmatchedStatement.length,
    );
  });

  it("adds the statement side of a suggestion the reviewer refused", () => {
    const memory = rejectAll(0);
    const needing = linesNeedingEntries(result, memory);

    expect(needing.length).toBe(result.unmatchedStatement.length + (result.suggested[0]?.statement.length ?? 0));
    for (const line of result.suggested[0]?.statement ?? []) {
      expect(needing.some((candidate) => candidate.id === line.id)).toBe(true);
    }
  });

  it("does not add a suggestion the reviewer confirmed", () => {
    const suggestion = result.suggested[0];
    const memory = MatchMemory.from(
      (suggestion?.statement ?? []).flatMap((statement) =>
        (suggestion?.book ?? []).map((book) => ({
          statementDescription: statement.description,
          bookDescription: book.description,
          accepted: true,
          on: date("2026-09-30"),
        })),
      ),
    );
    expect(linesNeedingEntries(result, memory)).toHaveLength(result.unmatchedStatement.length);
  });

  it("comes back in date order", () => {
    const needing = linesNeedingEntries(result, rejectAll(0));
    const dates = needing.map((line) => line.date);
    expect([...dates].sort()).toEqual(dates);
  });
});
