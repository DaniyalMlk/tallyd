/**
 * Whether a rules file is usable, and what that question is allowed to depend on.
 *
 * A rule is usable or it is not, and a statement has no say in it. That is
 * obvious said out loud and was not true of the engine: two of the three
 * conditions that make a rule unusable were decided inside the matcher, which
 * runs per line, behind an early return, behind `find`, behind a direction
 * check. The result was a rules file that one statement accepted and the next
 * refused.
 *
 * So the tests below are mostly about *independence*. Each one takes a rule
 * that cannot be used and asks for the same answer under conditions that used
 * to change it: the line's text, the rule's position in the list, the rule's
 * direction against the statement's, and whether there are any lines at all.
 */

import { describe, expect, it } from "vitest";
import { GBP, Money } from "../src/money/index.js";
import { date } from "../src/ledger/date.js";
import { statementLine, type StatementLine } from "../src/statement/line.js";
import {
  PostingRuleError,
  checkRule,
  checkRules,
  parseRules,
  proposeEntries,
  standardRules,
  type PostingRule,
} from "../src/reconcile/posting.js";

let row = 0;
function line(description: string, amount: string): StatementLine {
  row += 1;
  return statementLine({
    id: `BANK-${row}`,
    date: date("2026-03-31"),
    description,
    amount: Money.parse(amount, GBP),
    sourceRow: row,
  });
}

const propose = (lines: readonly StatementLine[], rules: readonly PostingRule[]): unknown =>
  proposeEntries(lines, { account: "1200", rules, suspenseAccount: "9999" });

/** A rule that matches only by exclusion: no positive clause at all. */
const NONE_ONLY: PostingRule = {
  id: "none-only",
  describe: "everything that is not rent",
  match: { none: ["RENT"] },
  account: "5800",
};

/** A rule with no clauses whatever. */
const EMPTY: PostingRule = {
  id: "empty",
  describe: "nothing",
  match: {},
  account: "5800",
};

/** A rule whose regex cannot be compiled. */
const BAD_REGEX: PostingRule = {
  id: "bad-regex",
  describe: "broken",
  match: { regex: "([unclosed" },
  account: "5800",
};

/** A rule that does match something, to sit in front of the malformed ones. */
const GOOD: PostingRule = {
  id: "takings",
  describe: "card takings",
  match: { any: ["TAKINGS"] },
  account: "4000",
};

const UNUSABLE: readonly [string, PostingRule, RegExp][] = [
  ["a rule that matches only by exclusion", NONE_ONLY, /matches on nothing/],
  ["a rule with no clauses at all", EMPTY, /matches on nothing/],
  ["a rule whose regex will not compile", BAD_REGEX, /unusable regex/],
  [
    "a booking rule that names no account",
    { id: "no-account", describe: "x", match: { any: ["X"] } },
    /names no account/,
  ],
];

describe("an unusable rule is unusable whatever the statement says", () => {
  // The line that the `none` clause excludes and the line it does not. Before
  // the check moved, the first of these returned false from the matcher and
  // the rule was never questioned.
  it.each(UNUSABLE)("refuses %s against a line it would exclude", (_label, rule, message) => {
    expect(() => propose([line("RENT PAYMENT", "-950.00")], [rule])).toThrow(PostingRuleError);
    expect(() => propose([line("RENT PAYMENT", "-950.00")], [rule])).toThrow(message);
  });

  it.each(UNUSABLE)("refuses %s against a line it would not exclude", (_label, rule, message) => {
    expect(() => propose([line("CARD TAKINGS", "140.00")], [rule])).toThrow(message);
  });

  it.each(UNUSABLE)("refuses %s with no lines to read at all", (_label, rule, message) => {
    expect(() => propose([], [rule])).toThrow(message);
  });
});

describe("an unusable rule is unusable wherever it sits", () => {
  // `find` stops at the first rule that matches, so a malformed rule behind a
  // matching one was never evaluated. These two orderings used to disagree.
  it.each(UNUSABLE)("refuses %s placed first", (_label, rule, message) => {
    expect(() => propose([line("CARD TAKINGS", "140.00")], [rule, GOOD])).toThrow(message);
  });

  it.each(UNUSABLE)("refuses %s placed behind a rule that matches", (_label, rule, message) => {
    expect(() => propose([line("CARD TAKINGS", "140.00")], [GOOD, rule])).toThrow(message);
  });
});

describe("an unusable rule is unusable in a direction the statement never takes", () => {
  // `directionAllows` is tested before the matcher, so an outbound-only rule
  // was not even looked at by an inbound statement.
  it.each(UNUSABLE)("refuses %s restricted to money out", (_label, rule, message) => {
    const outbound: PostingRule = { ...rule, direction: "out" };
    expect(() => propose([line("CARD TAKINGS", "140.00")], [outbound])).toThrow(message);
  });

  it.each(UNUSABLE)("refuses %s restricted to money in", (_label, rule, message) => {
    const inbound: PostingRule = { ...rule, direction: "in" };
    expect(() => propose([line("RENT PAYMENT", "-950.00")], [inbound])).toThrow(message);
  });
});

describe("a rules file is refused when it is read", () => {
  // The shape checks were always at read time; these three were not, so a file
  // could be read, held, and passed around before anybody found out.
  const bad: readonly [string, string, RegExp][] = [
    [
      "only an exclusion",
      JSON.stringify([{ id: "x", match: { none: ["RENT"] }, account: "5800" }]),
      /Rule x matches on nothing/,
    ],
    [
      "no clauses at all",
      JSON.stringify([{ id: "y", match: {}, account: "5800" }]),
      /Rule y matches on nothing/,
    ],
    [
      "a regex that will not compile",
      JSON.stringify([{ id: "z", match: { regex: "([unclosed" }, account: "5800" }]),
      /Rule z has an unusable regex/,
    ],
  ];

  it.each(bad)("refuses a rule with %s", (_label, text, message) => {
    expect(() => parseRules(text)).toThrow(PostingRuleError);
    expect(() => parseRules(text)).toThrow(message);
  });

  it("names the offending rule rather than its position", () => {
    // Two good rules and a bad one third: the message has to identify which.
    const text = JSON.stringify([
      { id: "first", match: { any: ["A"] }, account: "5800" },
      { id: "second", match: { any: ["B"] }, account: "5800" },
      { id: "third", match: { none: ["C"] }, account: "5800" },
    ]);
    expect(() => parseRules(text)).toThrow(/Rule third/);
  });

  it("still reads a file whose rules are usable", () => {
    const text = JSON.stringify([
      { id: "rent", match: { all: ["RENT"] }, direction: "out", account: "7100" },
      { id: "fees", match: { regex: "FEE|CHARGE" }, direction: "out", account: "7900" },
      { id: "open", match: { any: ["OPENING BALANCE"] }, action: "skip" },
    ]);
    const rules = parseRules(text);
    expect(rules.map((rule) => rule.id)).toEqual(["rent", "fees", "open"]);
    // And the regex rule it just accepted does its job.
    const proposals = proposeEntries([line("BANK CHARGE", "-12.00")], {
      account: "1200",
      rules,
      suspenseAccount: "9999",
    });
    expect(proposals[0]?.rule?.id).toBe("fees");
    expect(proposals[0]?.account).toBe("7900");
  });
});

describe("the check is available on its own", () => {
  it("passes every rule that comes in the box", () => {
    // If the shipped rules could not survive their own check the check would
    // be wrong, and this is the cheapest way to find that out.
    expect(() => checkRules(standardRules())).not.toThrow();
    for (const rule of standardRules()) expect(() => checkRule(rule)).not.toThrow();
  });

  it("stops at the first unusable rule in a set", () => {
    expect(() => checkRules([GOOD, NONE_ONLY, BAD_REGEX])).toThrow(/Rule none-only/);
  });

  it("accepts an exclusion alongside a positive clause", () => {
    // `none` is not the problem. A rule with something to match *and* an
    // exclusion is exactly what the standard interest rules are.
    expect(() =>
      checkRule({
        id: "fine",
        describe: "x",
        match: { any: ["INTEREST"], none: ["REVERSAL"] },
        account: "7300",
      }),
    ).not.toThrow();
  });

  it("accepts a skip rule with no account", () => {
    expect(() =>
      checkRule({ id: "skip", describe: "x", match: { any: ["OPENING"] }, action: "skip" }),
    ).not.toThrow();
  });
});

describe("the matcher compiles each regex once", () => {
  // The claim the refactor makes, measured rather than asserted: the pattern
  // cannot change between lines, so building it per line per rule was work
  // done again for the same answer — and was the reason an unusable pattern
  // could only be found by running into it.
  //
  // Counted by standing in front of the constructor for the duration of one
  // call, which is the only way to see from outside how often it was reached.
  function constructions(lines: readonly StatementLine[], rules: readonly PostingRule[]): number {
    const real = globalThis.RegExp;
    let count = 0;
    const counting = function (this: unknown, ...args: unknown[]): RegExp {
      count += 1;
      return new (real as unknown as new (...a: unknown[]) => RegExp)(...args);
    };
    Object.defineProperty(counting, "prototype", { value: real.prototype });
    globalThis.RegExp = counting as unknown as RegExpConstructor;
    try {
      proposeEntries(lines, { account: "1200", rules, suspenseAccount: "9999" });
    } finally {
      globalThis.RegExp = real;
    }
    return count;
  }

  const regexRule: PostingRule = {
    id: "fees",
    describe: "fees and charges",
    match: { regex: "FEE|CHARGE" },
    direction: "out",
    account: "7900",
  };

  it("builds one pattern for one rule however many lines there are", () => {
    const one = constructions([line("BANK CHARGE", "-12.00")], [regexRule]);
    const many = constructions(
      Array.from({ length: 40 }, (_, index) => line(`BANK CHARGE ${index}`, "-12.00")),
      [regexRule],
    );
    expect(one).toBe(1);
    expect(many).toBe(1);
  });

  it("builds one pattern per rule that has one, and none for the rest", () => {
    const second: PostingRule = { ...regexRule, id: "rent", match: { regex: "RENT" } };
    expect(constructions([line("BANK CHARGE", "-12.00")], [regexRule, second, GOOD])).toBe(2);
    expect(constructions([line("CARD TAKINGS", "140.00")], [GOOD])).toBe(0);
  });
});
