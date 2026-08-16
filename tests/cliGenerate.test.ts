import { describe, expect, it } from "vitest";
import { date } from "../src/ledger/index.js";
import { run, type CliEnvironment } from "../src/cli/run.js";
import { ledgerFromJson } from "../src/ledger/serialise.js";
import { importStatement } from "../src/statement/index.js";
import { GBP } from "../src/money/currency.js";

function harness(): { environment: CliEnvironment; written: Record<string, string> } {
  const written: Record<string, string> = {};
  return {
    written,
    environment: {
      readFile: (path: string) => {
        const contents = written[path];
        if (contents === undefined) throw new Error(`ENOENT: ${path}`);
        return contents;
      },
      writeFile: (path: string, contents: string) => {
        written[path] = contents;
      },
      today: () => date("2026-09-30"),
    },
  };
}

describe("tallyd generate", () => {
  it("writes a ledger and a statement", () => {
    const { environment, written } = harness();
    const result = run(["generate", "-o", "out", "--months", "2", "--invoices", "6"], environment);

    expect(result.code).toBe(0);
    expect(Object.keys(written).sort()).toEqual(["out/books.json", "out/statement.csv"]);
    expect(result.stdout).toContain("journal entries");
  });

  it("defaults the output directory to the current one", () => {
    const { environment, written } = harness();
    run(["generate", "--months", "1", "--invoices", "3"], environment);
    expect(Object.keys(written).sort()).toEqual(["./books.json", "./statement.csv"]);
  });

  it("writes ground truth only when asked", () => {
    const { environment, written } = harness();
    run(["generate", "-o", "out", "--months", "1", "--invoices", "4", "--truth"], environment);
    expect(written["out/truth.json"]).toBeDefined();

    const truth = JSON.parse(written["out/truth.json"] as string) as unknown[];
    expect(Array.isArray(truth)).toBe(true);
    expect(truth.length).toBeGreaterThan(0);
  });

  it("writes a ledger the loader accepts", () => {
    const { environment, written } = harness();
    run(["generate", "-o", "out", "--months", "2", "--invoices", "5"], environment);
    const ledger = ledgerFromJson(written["out/books.json"] as string);
    expect(() => ledger.verify()).not.toThrow();
    expect(ledger.size).toBeGreaterThan(10);
  });

  it("writes a statement the reader accepts", () => {
    const { environment, written } = harness();
    run(["generate", "-o", "out", "--months", "2", "--invoices", "5"], environment);
    const imported = importStatement(written["out/statement.csv"] as string, { currency: GBP });
    expect(imported.lines.length).toBeGreaterThan(10);
    expect(imported.format).toBe("csv");
  });

  it("produces books its own reconcile command balances", () => {
    const { environment } = harness();
    run(["generate", "-o", "out", "--months", "3", "--invoices", "8"], environment);
    const reconciled = run(
      ["reconcile", "-l", "out/books.json", "-s", "out/statement.csv"],
      environment,
    );
    expect(reconciled.code).toBe(0);
    expect(reconciled.stdout).toContain("Reconciled");
  });

  it("is reproducible from the seed", () => {
    const first = harness();
    const second = harness();
    run(["generate", "-o", "x", "--seed", "99", "--months", "2"], first.environment);
    run(["generate", "-o", "x", "--seed", "99", "--months", "2"], second.environment);
    expect(first.written["x/statement.csv"]).toBe(second.written["x/statement.csv"]);
  });

  it("changes with the seed", () => {
    const first = harness();
    const second = harness();
    run(["generate", "-o", "x", "--seed", "1", "--months", "2"], first.environment);
    run(["generate", "-o", "x", "--seed", "2", "--months", "2"], second.environment);
    expect(first.written["x/statement.csv"]).not.toBe(second.written["x/statement.csv"]);
  });

  it("honours --start and --currency", () => {
    const { environment, written } = harness();
    run(["generate", "-o", "out", "--start", "2027-06-01", "--currency", "USD"], environment);
    expect(written["out/statement.csv"]).toContain("01/06/2027");
    expect(written["out/books.json"]).toContain("USD");
  });

  it("emits JSON on request", () => {
    const { environment } = harness();
    const result = run(["generate", "-o", "out", "--months", "1", "--json"], environment);
    const parsed = JSON.parse(result.stdout) as { written: string[]; summary: { entries: number } };
    expect(parsed.written).toContain("out/books.json");
    expect(parsed.summary.entries).toBeGreaterThan(0);
  });

  it("rejects a nonsense size rather than generating something odd", () => {
    const { environment } = harness();
    expect(run(["generate", "--months", "0"], environment).code).toBe(1);
    expect(run(["generate", "--months", "-3"], environment).code).toBe(1);
    expect(run(["generate", "--invoices", "two"], environment).stderr).toContain("--invoices");
  });

  it("rejects a currency nobody has heard of", () => {
    const { environment } = harness();
    expect(run(["generate", "--currency", "ZZZ"], environment).code).toBe(1);
  });

  it("says so in a read-only environment rather than failing halfway", () => {
    const { environment } = harness();
    const readOnly: CliEnvironment = { readFile: environment.readFile, today: environment.today };
    const result = run(["generate", "-o", "out"], readOnly);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("cannot write files");
  });

  it("has help of its own", () => {
    const { environment } = harness();
    const help = run(["generate", "--help"], environment);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--truth");
  });
});

describe("tallyd bench", () => {
  it("times the matcher and reports accuracy beside it", () => {
    const { environment } = harness();
    const result = run(["bench", "--sizes", "1:6"], environment);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("size");
    expect(result.stdout).toContain("prec");
    // A benchmark that reports only wall time will one day celebrate a matcher
    // that stopped matching.
    expect(result.stdout).toContain("100.0%");
  });

  it("runs several sizes in the order given", () => {
    const { environment } = harness();
    const result = run(["bench", "--sizes", "1:6,2:6"], environment);
    expect(result.stdout.indexOf("1m x6")).toBeLessThan(result.stdout.indexOf("2m x6"));
  });

  it("emits JSON on request", () => {
    const { environment } = harness();
    const result = run(["bench", "--sizes", "1:6", "--json"], environment);
    const parsed = JSON.parse(result.stdout) as {
      seed: number;
      rows: { bookLines: number; milliseconds: number; precision: number; scoredShare: number }[];
    };
    expect(parsed.seed).toBe(1);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.bookLines).toBeGreaterThan(0);
    expect(parsed.rows[0]?.precision).toBe(1);
    expect(parsed.rows[0]?.scoredShare).toBeLessThan(0.2);
  });

  it("takes a repeat count", () => {
    const { environment } = harness();
    const result = run(["bench", "--sizes", "1:5", "--repeat", "3"], environment);
    expect(result.stdout).toContain("best of 3");
  });

  it("needs no filesystem at all", () => {
    const { environment } = harness();
    const readOnly: CliEnvironment = { readFile: environment.readFile, today: environment.today };
    expect(run(["bench", "--sizes", "1:5"], readOnly).code).toBe(0);
  });

  it("rejects a malformed size", () => {
    const { environment } = harness();
    expect(run(["bench", "--sizes", "banana"], environment).code).toBe(1);
    expect(run(["bench", "--sizes", "1:0"], environment).stderr).toContain("--sizes");
    expect(run(["bench", "--sizes", ""], environment).code).toBe(1);
  });

  it("appears in the top-level usage", () => {
    const { environment } = harness();
    const usage = run(["--help"], environment);
    expect(usage.stdout).toContain("generate");
    expect(usage.stdout).toContain("bench");
  });
});
