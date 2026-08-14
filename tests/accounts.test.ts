import { describe, expect, it } from "vitest";
import {
  ACCOUNT_TYPES,
  type AccountDefinition,
  AccountNotPostableError,
  ChartError,
  ChartOfAccounts,
  UnknownAccountError,
  debitSign,
  isBalanceSheet,
  isTemporary,
  normalBalanceOf,
  standardChart,
} from "../src/accounts/index.js";
import { EUR, GBP } from "../src/money/index.js";

const minimal: AccountDefinition[] = [
  { code: "1000", name: "Assets", type: "asset" },
  { code: "1100", name: "Bank", type: "asset", parent: "1000" },
  { code: "4000", name: "Income", type: "income" },
];

describe("account types", () => {
  it.each([
    ["asset", "debit", 1],
    ["expense", "debit", 1],
    ["liability", "credit", -1],
    ["equity", "credit", -1],
    ["income", "credit", -1],
  ] as const)("%s has a %s normal balance", (type, side, sign) => {
    expect(normalBalanceOf(type)).toBe(side);
    expect(debitSign(type)).toBe(sign);
  });

  it("splits the five types into statements", () => {
    const sheet = ACCOUNT_TYPES.filter(isBalanceSheet);
    const pnl = ACCOUNT_TYPES.filter(isTemporary);
    expect(sheet).toEqual(["asset", "liability", "equity"]);
    expect(pnl).toEqual(["income", "expense"]);
    expect(sheet.length + pnl.length).toBe(ACCOUNT_TYPES.length);
  });
});

describe("chart construction", () => {
  it("builds a tree with depth and paths", () => {
    const chart = ChartOfAccounts.build(minimal);
    expect(chart.size).toBe(3);
    expect(chart.get("1100").depth).toBe(1);
    expect(chart.get("1100").path).toBe("Assets:Bank");
    expect(chart.roots).toEqual(["1000", "4000"]);
  });

  it("marks parents as placeholders by default", () => {
    const chart = ChartOfAccounts.build(minimal);
    expect(chart.get("1000").placeholder).toBe(true);
    expect(chart.get("1100").placeholder).toBe(false);
  });

  it("lets a leaf be declared a placeholder explicitly", () => {
    const chart = ChartOfAccounts.build([
      { code: "1000", name: "Assets", type: "asset", placeholder: true },
    ]);
    expect(chart.isPostable("1000")).toBe(false);
  });

  it("inherits the chart currency and allows per-account overrides", () => {
    const chart = ChartOfAccounts.build(
      [...minimal, { code: "1200", name: "EUR Bank", type: "asset", parent: "1000", currency: EUR }],
      { currency: GBP },
    );
    expect(chart.get("1100").currency).toBe(GBP);
    expect(chart.get("1200").currency).toBe(EUR);
  });

  it("rejects duplicate codes", () => {
    expect(() =>
      ChartOfAccounts.build([...minimal, { code: "1000", name: "Again", type: "asset" }]),
    ).toThrow(/Duplicate account code: 1000/);
  });

  it("rejects a missing parent", () => {
    expect(() =>
      ChartOfAccounts.build([{ code: "1100", name: "Bank", type: "asset", parent: "9999" }]),
    ).toThrow(/missing parent: 9999/);
  });

  it("rejects a child whose type disagrees with its parent", () => {
    expect(() =>
      ChartOfAccounts.build([
        { code: "1000", name: "Assets", type: "asset" },
        { code: "1100", name: "Wrong", type: "expense", parent: "1000" },
      ]),
    ).toThrow(/is expense but its parent 1000 is asset/);
  });

  it("rejects a cycle", () => {
    expect(() =>
      ChartOfAccounts.build([
        { code: "A", name: "A", type: "asset", parent: "B" },
        { code: "B", name: "B", type: "asset", parent: "A" },
      ]),
    ).toThrow(/cycle/);
  });

  it("rejects an account that is its own parent", () => {
    expect(() =>
      ChartOfAccounts.build([{ code: "A", name: "A", type: "asset", parent: "A" }]),
    ).toThrow(/cycle/);
  });

  it("rejects blank codes, blank names and unknown types", () => {
    expect(() => ChartOfAccounts.build([{ code: " ", name: "x", type: "asset" }])).toThrow(
      ChartError,
    );
    expect(() => ChartOfAccounts.build([{ code: "1", name: "  ", type: "asset" }])).toThrow(
      ChartError,
    );
    expect(() =>
      ChartOfAccounts.build([
        { code: "1", name: "x", type: "revenue" as unknown as "income" },
      ]),
    ).toThrow(/unknown type/);
  });

  it("accepts an empty chart", () => {
    const chart = ChartOfAccounts.build([]);
    expect(chart.size).toBe(0);
    expect(chart.list()).toEqual([]);
  });
});

describe("navigation", () => {
  const chart = standardChart();

  it("walks children, descendants and ancestors", () => {
    expect(chart.children("1100").map((a) => a.code)).toContain("1110");
    expect(chart.descendants("1000").length).toBeGreaterThan(5);
    expect(chart.ancestors("1110").map((a) => a.code)).toEqual(["1100", "1000"]);
    expect(chart.ancestors("1000")).toEqual([]);
  });

  it("includes the root itself in a subtree", () => {
    const subtree = chart.subtree("1100").map((a) => a.code);
    expect(subtree[0]).toBe("1100");
    expect(subtree).toContain("1110");
  });

  it("answers descendant questions", () => {
    expect(chart.isDescendantOf("1110", "1000")).toBe(true);
    expect(chart.isDescendantOf("1000", "1110")).toBe(false);
    expect(chart.isDescendantOf("1110", "1110")).toBe(false);
  });

  it("resolves by path", () => {
    expect(chart.findByPath("Assets:Current Assets:Bank")?.code).toBe("1110");
    expect(chart.findByPath("Assets:Nope")).toBeUndefined();
  });

  it("lists leaves and types", () => {
    expect(chart.leaves().every((a) => a.children.length === 0)).toBe(true);
    expect(chart.ofType("income").map((a) => a.code)).toContain("4100");
    expect(chart.ofType("income").every((a) => a.type === "income")).toBe(true);
  });

  it("returns accounts in depth-first order", () => {
    const codes = chart.list().map((a) => a.code);
    expect(codes.indexOf("1000")).toBeLessThan(codes.indexOf("1110"));
    expect(codes.indexOf("1110")).toBeLessThan(codes.indexOf("2000"));
  });

  it("throws a named error for unknown codes", () => {
    expect(() => chart.get("nope")).toThrow(UnknownAccountError);
    expect(chart.find("nope")).toBeUndefined();
    expect(chart.has("1110")).toBe(true);
  });
});

describe("postability", () => {
  const chart = ChartOfAccounts.build([
    ...minimal,
    { code: "1200", name: "Old Bank", type: "asset", parent: "1000", closed: true },
  ]);

  it("accepts an open leaf", () => {
    expect(chart.assertPostable("1100").code).toBe("1100");
    expect(chart.isPostable("1100")).toBe(true);
  });

  it("rejects placeholders", () => {
    expect(() => chart.assertPostable("1000")).toThrow(AccountNotPostableError);
    expect(() => chart.assertPostable("1000")).toThrow(/placeholder/);
  });

  it("rejects closed accounts", () => {
    expect(() => chart.assertPostable("1200")).toThrow(/closed/);
    expect(chart.isPostable("1200")).toBe(false);
  });

  it("reports unknown accounts as not postable", () => {
    expect(chart.isPostable("9999")).toBe(false);
    expect(() => chart.assertPostable("9999")).toThrow(UnknownAccountError);
  });
});

describe("derivation", () => {
  it("round-trips through definitions", () => {
    const chart = standardChart();
    const rebuilt = ChartOfAccounts.build(chart.toDefinitions(), { currency: GBP });
    expect(rebuilt.list().map((a) => a.path)).toEqual(chart.list().map((a) => a.path));
    expect(rebuilt.size).toBe(chart.size);
  });

  it("extends without mutating the original", () => {
    const chart = ChartOfAccounts.build(minimal);
    const extended = chart.extend([
      { code: "1200", name: "Savings", type: "asset", parent: "1000" },
    ]);
    expect(extended.has("1200")).toBe(true);
    expect(chart.has("1200")).toBe(false);
    expect(chart.size).toBe(3);
  });

  it("re-validates on extend", () => {
    const chart = ChartOfAccounts.build(minimal);
    expect(() => chart.extend([{ code: "1100", name: "Clash", type: "asset" }])).toThrow(
      /Duplicate/,
    );
  });

  it("renders an indented tree", () => {
    const rendered = ChartOfAccounts.build(minimal).render();
    expect(rendered).toContain("1000  Assets ·");
    expect(rendered).toContain("  1100  Bank");
  });
});

describe("the standard chart", () => {
  const chart = standardChart();

  it("covers all five account types", () => {
    for (const type of ACCOUNT_TYPES) {
      expect(chart.ofType(type).length).toBeGreaterThan(0);
    }
  });

  it("has exactly five roots, one per type", () => {
    expect(chart.roots).toHaveLength(5);
    expect(new Set(chart.roots.map((c) => chart.get(c).type)).size).toBe(5);
  });

  it("keeps every leaf postable", () => {
    for (const leaf of chart.leaves()) {
      expect(chart.isPostable(leaf.code)).toBe(true);
    }
  });

  it("gives every account a type matching its code block", () => {
    const expected: Record<string, string> = {
      "1": "asset",
      "2": "liability",
      "3": "equity",
      "4": "income",
      "5": "expense",
    };
    for (const account of chart.list()) {
      expect(account.type).toBe(expected[account.code[0] as string]);
    }
  });
});
