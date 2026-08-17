import { describe, expect, it } from "vitest";
import { date } from "../src/ledger/index.js";
import { run, type CliEnvironment } from "../src/cli/run.js";
import { MatchMemory } from "../src/reconcile/memory.js";
import { GBP, Money } from "../src/money/index.js";
import { importCsv } from "../src/statement/import.js";
import { bankView } from "../src/reconcile/bankView.js";
import { reconcile } from "../src/reconcile/matcher.js";
import { statementClosingBalance } from "../src/reconcile/bridge.js";
import { dashboardData } from "../src/dashboard/model.js";
import { decisionRecord, serialiseDecisions } from "../src/reconcile/decisions.js";
import { supplierRunLedger, SUPPLIER_RUN_CSV } from "../src/demo/supplierRun.js";

function harness(seed: Record<string, string> = {}): {
  environment: CliEnvironment;
  files: Record<string, string>;
} {
  const files: Record<string, string> = { ...seed };
  return {
    files,
    environment: {
      readFile: (path: string) => {
        const contents = files[path];
        if (contents === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
        return contents;
      },
      writeFile: (path: string, contents: string) => {
        files[path] = contents;
      },
      today: () => date("2026-09-30"),
    },
  };
}

const DECISIONS = JSON.stringify([
  {
    statement: "FPO ASHGROVE SUPPLIES 4471",
    book: "Payment — Ashgrove Supplies",
    accepted: true,
    on: "2026-03-31",
  },
  {
    statement: "BGC NORTHWIND LTD 8822",
    book: "Receipt — Northwind Ltd",
    accepted: true,
    on: "2026-03-31",
  },
  {
    statement: "FPO KETTLEBY PRINT 1",
    book: "Payment — Ashgrove Supplies",
    accepted: false,
    on: "2026-03-31",
  },
]);

describe("tallyd learn", () => {
  it("creates a memory from decisions when none exists yet", () => {
    const { environment, files } = harness({ "decisions.json": DECISIONS });
    const result = run(["learn", "-m", "memory.json", "-d", "decisions.json"], environment);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("3 decisions");
    expect(result.stdout).toContain("3 pairings remembered, 3 new");

    const memory = MatchMemory.fromJson(files["memory.json"] as string);
    expect(memory.size).toBe(3);
  });

  it("adds to a memory that already exists", () => {
    const existing = MatchMemory.from([
      {
        statementDescription: "FPO ASHGROVE SUPPLIES 1",
        bookDescription: "Payment — Ashgrove Supplies",
        accepted: true,
        on: date("2026-01-31"),
      },
    ]);
    const { environment, files } = harness({
      "decisions.json": DECISIONS,
      "memory.json": existing.toJson(),
    });

    const result = run(["learn", "-m", "memory.json", "-d", "decisions.json"], environment);
    expect(result.stdout).toContain("3 pairings remembered, 2 new");

    const memory = MatchMemory.fromJson(files["memory.json"] as string);
    // The repeat of a pairing already known counts twice, not as a new entry.
    expect(memory.recall("FPO ASHGROVE SUPPLIES 9", "Payment — Ashgrove Supplies").confirmed).toBe(2);
  });

  it("shows what is remembered without writing anything", () => {
    const { environment, files } = harness({ "decisions.json": DECISIONS });
    run(["learn", "-m", "memory.json", "-d", "decisions.json"], environment);
    const before = files["memory.json"];

    const shown = run(["learn", "-m", "memory.json", "--show"], environment);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("ASHGROVE");
    expect(shown.stdout).toContain("yes/no");
    expect(files["memory.json"]).toBe(before);
  });

  it("shows an empty memory as a sentence", () => {
    const { environment } = harness();
    expect(run(["learn", "-m", "memory.json", "--show"], environment).stdout).toBe(
      "Nothing remembered yet.",
    );
  });

  it("emits JSON on request", () => {
    const { environment } = harness({ "decisions.json": DECISIONS });
    const result = run(["learn", "-m", "memory.json", "-d", "decisions.json", "--json"], environment);
    const parsed = JSON.parse(result.stdout) as { decisions: number; pairings: number; new: number };
    expect(parsed).toEqual({ memory: "memory.json", decisions: 3, pairings: 3, new: 3 });
  });

  it("shows JSON on request", () => {
    const { environment } = harness({ "decisions.json": DECISIONS });
    run(["learn", "-m", "memory.json", "-d", "decisions.json"], environment);
    const shown = run(["learn", "-m", "memory.json", "--show", "--json"], environment);
    const parsed = JSON.parse(shown.stdout) as { version: number; entries: unknown[] };
    expect(parsed.version).toBe(1);
    expect(parsed.entries).toHaveLength(3);
  });

  it("needs a memory path", () => {
    const { environment } = harness({ "decisions.json": DECISIONS });
    expect(run(["learn", "-d", "decisions.json"], environment).code).toBe(1);
  });

  it("needs a decisions file unless it is only showing", () => {
    const { environment } = harness();
    expect(run(["learn", "-m", "memory.json"], environment).code).toBe(1);
  });

  it("rejects a decisions file that is not JSON", () => {
    const { environment } = harness({ "decisions.json": "{ not json" });
    const result = run(["learn", "-m", "memory.json", "-d", "decisions.json"], environment);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not valid JSON");
  });

  it("rejects decisions that are not an array", () => {
    const { environment } = harness({ "decisions.json": '{"statement":"a"}' });
    expect(run(["learn", "-m", "memory.json", "-d", "decisions.json"], environment).stderr).toContain(
      "JSON array",
    );
  });

  it("names the decision that is malformed", () => {
    const { environment } = harness({
      "decisions.json": JSON.stringify([
        { statement: "a", book: "b", accepted: true, on: "2026-01-01" },
        { statement: "a", book: "b", accepted: "yes", on: "2026-01-01" },
      ]),
    });
    expect(run(["learn", "-m", "memory.json", "-d", "decisions.json"], environment).stderr).toContain(
      "Decision 1",
    );
  });

  it("rejects a decision missing its descriptions or date", () => {
    const missing = (entry: unknown) => {
      const { environment } = harness({ "decisions.json": JSON.stringify([entry]) });
      return run(["learn", "-m", "memory.json", "-d", "decisions.json"], environment);
    };
    expect(missing({ book: "b", accepted: true, on: "2026-01-01" }).code).toBe(1);
    expect(missing({ statement: "a", book: "b", accepted: true }).stderr).toContain("date");
    expect(missing({ statement: "a", book: "b", accepted: true, on: "nonsense" }).code).toBe(1);
  });

  it("refuses to corrupt a memory file that is malformed", () => {
    const { environment } = harness({
      "decisions.json": DECISIONS,
      "memory.json": '{"version":9,"entries":[]}',
    });
    const result = run(["learn", "-m", "memory.json", "-d", "decisions.json"], environment);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("version");
  });

  it("says so in a read-only environment", () => {
    const { environment } = harness({ "decisions.json": DECISIONS });
    const readOnly: CliEnvironment = { readFile: environment.readFile, today: environment.today };
    const result = run(["learn", "-m", "memory.json", "-d", "decisions.json"], readOnly);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("cannot write files");
  });

  it("appears in the usage", () => {
    const { environment } = harness();
    expect(run(["--help"], environment).stdout).toContain("learn");
  });
});

describe("reconcile with a memory", () => {
  it("says how many counterparties are in play", () => {
    const { environment, files } = harness({ "decisions.json": DECISIONS });
    run(["learn", "-m", "memory.json", "-d", "decisions.json"], environment);
    run(["generate", "-o", "gen", "--months", "3", "--invoices", "8"], environment);

    const warm = run(
      ["reconcile", "-l", "gen/books.json", "-s", "gen/statement.csv", "-m", "memory.json"],
      environment,
    );
    expect(warm.code).toBe(0);
    expect(warm.stdout).toContain("remembered");
    expect(files["memory.json"]).toBeDefined();
  });

  it("treats a memory file that is not there as an empty one", () => {
    const { environment } = harness();
    run(["generate", "-o", "gen", "--months", "2", "--invoices", "6"], environment);

    const cold = run(["reconcile", "-l", "gen/books.json", "-s", "gen/statement.csv"], environment);
    const missing = run(
      ["reconcile", "-l", "gen/books.json", "-s", "gen/statement.csv", "-m", "nowhere.json"],
      environment,
    );
    expect(missing.code).toBe(cold.code);
    expect(missing.stdout).toBe(cold.stdout);
  });

  it("still refuses a memory file that exists and is malformed", () => {
    const { environment } = harness({ "memory.json": '{"version":1}' });
    run(["generate", "-o", "gen", "--months", "2", "--invoices", "6"], environment);
    const result = run(
      ["reconcile", "-l", "gen/books.json", "-s", "gen/statement.csv", "-m", "memory.json"],
      environment,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("entries");
  });

  it("is offered by the dashboard command too", () => {
    const { environment } = harness({ "decisions.json": DECISIONS });
    run(["learn", "-m", "memory.json", "-d", "decisions.json"], environment);
    run(["generate", "-o", "gen", "--months", "2", "--invoices", "6"], environment);

    const result = run(
      [
        "dashboard",
        "-l",
        "gen/books.json",
        "-s",
        "gen/statement.csv",
        "-m",
        "memory.json",
        "-o",
        "out.html",
      ],
      environment,
    );
    expect(result.code).toBe(0);
    expect(run(["dashboard", "--help"], environment).stdout).toContain("--memory");
  });
});

/**
 * The loop, end to end and without a browser in it: a reconciliation is
 * flattened for the page, the page's own payloads are stamped with a verdict
 * and a date exactly as the client script does, and the resulting file is
 * handed to `tallyd learn`. Nothing between the two ends is hand-written.
 */
describe("a decisions file the dashboard would have written", () => {
  function pageDecisions(accepted: boolean): { text: string; facts: number } {
    const ledger = supplierRunLedger();
    const imported = importCsv(SUPPLIER_RUN_CSV, { currency: GBP, idPrefix: "BANK" });
    const books = bankView(ledger, "1110");
    const result = reconcile(books, imported.lines);
    const data = dashboardData({
      ledger,
      account: "1110",
      books,
      statement: imported.lines,
      result,
      bankClosingBalance: statementClosingBalance(imported.lines, Money.zero(GBP)),
      bookClosingBalance: books.reduce((total, line) => total.plus(line.amount), Money.zero(GBP)),
      statementFormat: "csv",
    });

    const records = [...data.matched, ...data.suggested].flatMap((match) =>
      match.decision.map((payload) => decisionRecord(payload, accepted, "2026-09-30")),
    );
    return { text: serialiseDecisions(records), facts: records.length };
  }

  it("is read without a single edit", () => {
    const { text, facts } = pageDecisions(true);
    const { environment, files } = harness({ "decisions.json": text });

    const result = run(["learn", "-m", "memory.json", "-d", "decisions.json"], environment);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Read ${facts} decisions`);
    expect(files["memory.json"]).toBeDefined();
  });

  it("teaches the matcher every counterparty in it", () => {
    const { text } = pageDecisions(true);
    const { environment, files } = harness({ "decisions.json": text });
    run(["learn", "-m", "memory.json", "-d", "decisions.json"], environment);

    const memory = MatchMemory.fromJson(files["memory.json"] as string);
    expect(memory.size).toBeGreaterThan(0);
    for (const entry of memory.entries) expect(entry.confirmed).toBeGreaterThan(0);
  });

  it("a queue rejected wholesale teaches only refusals", () => {
    const { text } = pageDecisions(false);
    const { environment, files } = harness({ "decisions.json": text });
    run(["learn", "-m", "memory.json", "-d", "decisions.json"], environment);

    const memory = MatchMemory.fromJson(files["memory.json"] as string);
    for (const entry of memory.entries) {
      expect(entry.rejected).toBeGreaterThan(0);
      expect(entry.confirmed).toBe(0);
    }
  });

  it("the context the page attaches is carried without being believed", () => {
    const { text } = pageDecisions(true);
    expect(text).toContain('"context"');

    const { environment, files } = harness({ "decisions.json": text });
    run(["learn", "-m", "memory.json", "-d", "decisions.json"], environment);

    const stripped = JSON.parse(text) as Record<string, unknown>[];
    for (const record of stripped) delete record["context"];
    const { environment: bare, files: bareFiles } = harness({
      "decisions.json": JSON.stringify(stripped),
    });
    run(["learn", "-m", "memory.json", "-d", "decisions.json"], bare);

    expect(bareFiles["memory.json"]).toBe(files["memory.json"]);
  });
});
