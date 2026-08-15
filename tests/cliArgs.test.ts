import { describe, expect, it } from "vitest";
import {
  ArgumentError,
  booleanFlag,
  listFlag,
  parseArgs,
  renderFlags,
  requiredFlag,
  stringFlag,
  type FlagSpecs,
} from "../src/cli/args.js";

const specs: FlagSpecs = {
  ledger: { kind: "string", short: "l", describe: "Ledger file" },
  account: { kind: "string", short: "a", describe: "Account code" },
  tag: { kind: "list", short: "t", describe: "Tag to include" },
  json: { kind: "boolean", describe: "Emit JSON" },
  verbose: { kind: "boolean", short: "V", describe: "Say more" },
};

describe("parseArgs", () => {
  it("reads a long flag with a separate value", () => {
    expect(parseArgs(["--ledger", "books.json"], specs).flags).toEqual({ ledger: "books.json" });
  });

  it("reads a long flag with an inline value", () => {
    expect(parseArgs(["--ledger=books.json"], specs).flags).toEqual({ ledger: "books.json" });
  });

  it("treats both spellings as identical", () => {
    expect(parseArgs(["--account=1110"], specs)).toEqual(parseArgs(["--account", "1110"], specs));
  });

  it("reads short aliases, inline and separated", () => {
    expect(parseArgs(["-l", "books.json"], specs).flags).toEqual({ ledger: "books.json" });
    expect(parseArgs(["-l=books.json"], specs).flags).toEqual({ ledger: "books.json" });
  });

  it("collects positional arguments in order", () => {
    const parsed = parseArgs(["one", "--json", "two", "-l", "x", "three"], specs);
    expect(parsed.positional).toEqual(["one", "two", "three"]);
    expect(parsed.flags).toEqual({ json: true, ledger: "x" });
  });

  it("accepts a value that begins with a dash", () => {
    // An account code, a negative amount, a date range — all legitimate.
    expect(parseArgs(["--account", "-1100"], specs).flags).toEqual({ account: "-1100" });
    expect(parseArgs(["--account=-1100"], specs).flags).toEqual({ account: "-1100" });
  });

  it("stops parsing at a bare --", () => {
    const parsed = parseArgs(["--json", "--", "--ledger", "-x", "plain"], specs);
    expect(parsed.flags).toEqual({ json: true });
    expect(parsed.positional).toEqual(["--ledger", "-x", "plain"]);
  });

  it("treats a lone dash as positional", () => {
    expect(parseArgs(["-"], specs).positional).toEqual(["-"]);
  });

  it("accumulates a list flag and keeps single values working", () => {
    expect(listFlag(parseArgs(["-t", "a", "--tag", "b", "--tag=c"], specs), "tag")).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(listFlag(parseArgs(["--tag", "only"], specs), "tag")).toEqual(["only"]);
    expect(listFlag(parseArgs([], specs), "tag")).toEqual([]);
  });

  it("lets a later value win for a plain string flag", () => {
    expect(stringFlag(parseArgs(["-l", "a", "-l", "b"], specs), "ledger")).toBe("b");
  });

  it("accepts an explicit true or false on a switch", () => {
    expect(parseArgs(["--json=false"], specs).flags).toEqual({ json: false });
    expect(booleanFlag(parseArgs(["--json=false"], specs), "json")).toBe(false);
    expect(booleanFlag(parseArgs(["--json"], specs), "json")).toBe(true);
    expect(booleanFlag(parseArgs([], specs), "json")).toBe(false);
  });

  it("rejects a value on a switch that is not a boolean", () => {
    expect(() => parseArgs(["--json=maybe"], specs)).toThrow(/takes no value/);
  });

  it("rejects an unknown flag rather than ignoring it", () => {
    expect(() => parseArgs(["--nope"], specs)).toThrow(ArgumentError);
    expect(() => parseArgs(["--as-a", "x"], specs)).toThrow(/Unknown option: --as-a/);
    expect(() => parseArgs(["-z"], specs)).toThrow(/Unknown option: -z/);
  });

  it("rejects a flag left without its value", () => {
    expect(() => parseArgs(["--ledger"], specs)).toThrow(/--ledger needs a value/);
    expect(() => parseArgs(["--json", "--ledger"], specs)).toThrow(/needs a value/);
  });

  it("handles an empty argv", () => {
    expect(parseArgs([], specs)).toEqual({ positional: [], flags: {} });
  });

  it("accepts an empty inline value", () => {
    expect(parseArgs(["--ledger="], specs).flags).toEqual({ ledger: "" });
  });
});

describe("flag accessors", () => {
  it("requiredFlag names the flag it wanted", () => {
    expect(() => requiredFlag(parseArgs([], specs), "ledger")).toThrow(/--ledger is required/);
    expect(requiredFlag(parseArgs(["-l", "x"], specs), "ledger")).toBe("x");
  });

  it("stringFlag refuses a repeated list value", () => {
    const parsed = parseArgs(["--tag", "a", "--tag", "b"], specs);
    expect(() => stringFlag(parsed, "tag")).toThrow(/takes a single value/);
  });

  it("stringFlag returns undefined when the flag was not given", () => {
    expect(stringFlag(parseArgs([], specs), "ledger")).toBeUndefined();
  });
});

describe("renderFlags", () => {
  it("aligns the descriptions and shows aliases and placeholders", () => {
    const text = renderFlags(specs);
    expect(text).toContain("-l, --ledger <value>");
    expect(text).toContain("    --json");
    expect(text).toContain("-t, --tag <value...>");

    const columns = Object.entries(specs).map(([name, spec]) => {
      const line = text.split("\n").find((l) => l.includes(`--${name}`)) as string;
      return line.indexOf(spec.describe);
    });
    expect(new Set(columns).size).toBe(1);
    expect(columns[0]).toBe(25);
  });

  it("is empty for an empty table", () => {
    expect(renderFlags({})).toBe("");
  });
});
