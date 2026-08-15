import { describe, expect, it } from "vitest";
import { date } from "../src/ledger/index.js";
import { ledgerToJson } from "../src/ledger/serialise.js";
import { run, type CliEnvironment } from "../src/cli/run.js";
import { demoLedger } from "../src/demo/month.js";
import { receivablesLedger } from "../src/demo/receivables.js";
import { DEMO_BANK_CSV, DEMO_BANK_OFX } from "../src/demo/statement.js";

/**
 * An in-memory filesystem. The CLI takes its reader as a parameter precisely
 * so the whole thing can be exercised without touching disk or spawning a
 * process — these are the same code paths the binary runs.
 */
const FILES: Record<string, string> = {
  "month.json": ledgerToJson(demoLedger()),
  "quarter.json": ledgerToJson(receivablesLedger()),
  "bank.csv": DEMO_BANK_CSV,
  "bank.ofx": DEMO_BANK_OFX,
  "no-chart.json": JSON.stringify({
    version: 1,
    currency: "GBP",
    accounts: [],
    entries: [
      {
        id: "JE-1",
        date: "2026-08-01",
        narration: "Something",
        postings: [
          { account: "A", amount: "10.00", currency: "GBP" },
          { account: "B", amount: "-10.00", currency: "GBP" },
        ],
      },
    ],
  }),
  // The balance column disagrees with the movements: the bank says it closed
  // at 100.00 but the lines only add up to 50.00.
  "wrong-balance.csv": [
    "Date,Description,Paid Out,Paid In,Balance",
    "01/08/2026,BGC SHARE CAPITAL,,25000.00,25000.00",
    "31/08/2026,BANK CHARGES,18.00,,99999.00",
  ].join("\n"),
  "broken.json": "{ not json",
};

const WRITTEN: Record<string, string> = {};

const environment: CliEnvironment = {
  readFile: (path: string) => {
    const contents = FILES[path];
    if (contents === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    return contents;
  },
  writeFile: (path: string, contents: string) => {
    WRITTEN[path] = contents;
  },
  today: () => date("2026-09-30"),
};

const readOnly: CliEnvironment = {
  readFile: environment.readFile,
  today: environment.today,
};

const cli = (...argv: string[]) => run(argv, environment);

describe("usage and help", () => {
  it("prints usage with no arguments, and fails, because nothing was asked for", () => {
    const result = cli();
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Usage: tallyd <command>");
  });

  it("prints usage for --help and succeeds", () => {
    expect(cli("--help").code).toBe(0);
    expect(cli("help").stdout).toContain("Commands:");
  });

  it("documents every command's options", () => {
    for (const command of ["report", "ageing", "reconcile", "import", "accounts"]) {
      const result = cli(command, "--help");
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`tallyd ${command}`);
      expect(result.stdout).toContain("Options:");
    }
  });

  it("reports its version", () => {
    expect(cli("--version").stdout).toBe("tallyd 0.1.0");
  });

  it("rejects an unknown command on stderr", () => {
    const result = cli("frobnicate");
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown command: frobnicate");
  });
});

describe("report", () => {
  it("prints all three statements and succeeds", () => {
    const result = cli("report", "-l", "quarter.json", "--as-at", "2026-09-30");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Trial balance as at 2026-09-30");
    expect(result.stdout).toContain("Income statement (GBP)");
    expect(result.stdout).toContain("Balance sheet (GBP) as at 2026-09-30");
    expect(result.stdout).toContain("Balanced");
  });

  it("defaults the as-at date to today", () => {
    expect(cli("report", "-l", "quarter.json").stdout).toContain("as at 2026-09-30");
  });

  it("accepts a period and a comparative", () => {
    const result = cli(
      "report",
      "-l",
      "quarter.json",
      "--as-at=2026-09-30",
      "--from=2026-07-01",
      "--to=2026-09-30",
      "--compare=2026-04-01:2026-06-30",
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("comparative period: 2026-04-01 to 2026-06-30");
    expect(result.stdout).toContain("1188.35");
  });

  it("rejects a malformed comparative", () => {
    const result = cli("report", "-l", "quarter.json", "--compare", "2026-04-01");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--compare wants from:to");
  });

  it("emits JSON carrying the same figures as the text", () => {
    const result = cli("report", "-l", "quarter.json", "--as-at", "2026-09-30", "--json");
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      balanceSheet: { assets: string; balanced: boolean };
      incomeStatement: { netResult: string };
      trialBalance: { balanced: boolean };
    };
    expect(parsed.balanceSheet.assets).toBe("19678.35");
    expect(parsed.balanceSheet.balanced).toBe(true);
    expect(parsed.trialBalance.balanced).toBe(true);

    const text = cli("report", "-l", "quarter.json", "--as-at", "2026-09-30").stdout;
    expect(text).toContain(parsed.balanceSheet.assets);
    expect(text).toContain(parsed.incomeStatement.netResult);
  });
});

describe("ageing", () => {
  it("prints the schedule for a control account", () => {
    const result = cli("ageing", "-l", "quarter.json", "-a", "1130", "--as-at", "2026-09-30");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Ageing — 1130 Accounts Receivable");
    expect(result.stdout).toContain("INV-2001");
  });

  it("accepts custom bucket boundaries", () => {
    const result = cli(
      "ageing",
      "-l",
      "quarter.json",
      "-a",
      "1130",
      "--as-at",
      "2026-09-30",
      "--buckets",
      "45,90",
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("0-45");
    expect(result.stdout).toContain("91+");
  });

  it("rejects nonsense boundaries", () => {
    const bad = cli("ageing", "-l", "quarter.json", "-a", "1130", "--buckets", "thirty");
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("positive whole numbers");

    const negative = cli("ageing", "-l", "quarter.json", "-a", "1130", "--buckets", "-5");
    expect(negative.code).toBe(1);
  });

  it("requires the account", () => {
    const result = cli("ageing", "-l", "quarter.json");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--account is required");
  });

  it("emits JSON whose buckets sum to the total", () => {
    const result = cli(
      "ageing",
      "-l",
      "quarter.json",
      "-a",
      "1130",
      "--as-at",
      "2026-09-30",
      "--json",
    );
    const parsed = JSON.parse(result.stdout) as {
      total: string;
      buckets: { total: string }[];
      items: { reference: string }[];
    };
    const summed = parsed.buckets.reduce((sum, bucket) => sum + Number(bucket.total), 0);
    expect(summed.toFixed(2)).toBe(Number(parsed.total).toFixed(2));
    expect(parsed.items.map((item) => item.reference)).toEqual([
      "INV-2001",
      "INV-2003",
      "INV-2005",
      "INV-2007",
    ]);
  });
});

describe("reconcile", () => {
  it("matches the worked month and balances", () => {
    const result = cli("reconcile", "-l", "month.json", "-s", "bank.csv");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Reconciling 1110 against 12 statement lines");
    expect(result.stdout).toContain("7 matched, 2 to review");
    expect(result.stdout).toContain("Reconciled");
    expect(result.stderr).toBe("");
  });

  it("reads OFX as readily as CSV", () => {
    const result = cli("reconcile", "-l", "month.json", "-s", "bank.ofx", "--json");
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { format: string }).format).toBe("ofx");
  });

  it("exits 2 when the reconciliation does not balance", () => {
    const result = cli("reconcile", "-l", "month.json", "-s", "wrong-balance.csv");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("does not balance");
    expect(result.stdout).toContain("UNRECONCILED DIFFERENCE");
  });

  it("can be told to skip group matching", () => {
    const withGroups = cli("reconcile", "-l", "month.json", "-s", "bank.csv", "--json");
    const without = cli("reconcile", "-l", "month.json", "-s", "bank.csv", "--no-groups", "--json");
    expect(withGroups.code).toBe(0);
    expect(without.code).toBe(0);
    const parsed = JSON.parse(without.stdout) as { matched: { kind: string }[] };
    expect(parsed.matched.every((match) => match.kind === "one-to-one")).toBe(true);
  });

  it("honours a tightened date window", () => {
    const result = cli(
      "reconcile",
      "-l",
      "month.json",
      "-s",
      "bank.csv",
      "--date-window",
      "0",
      "--json",
    );
    expect(result.code).toBe(0);
  });

  it("rejects a date window that is not a whole number of days", () => {
    const result = cli("reconcile", "-l", "month.json", "-s", "bank.csv", "--date-window", "two");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("whole number of days");
  });

  it("rejects an account that is not in the chart", () => {
    const result = cli("reconcile", "-l", "month.json", "-s", "bank.csv", "-a", "9999");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No account 9999");
  });

  it("emits JSON with the bridge and the review queue's reasoning", () => {
    const result = cli("reconcile", "-l", "month.json", "-s", "bank.csv", "--json");
    const parsed = JSON.parse(result.stdout) as {
      matched: unknown[];
      suggested: { reasons: string[] }[];
      bridge: { reconciled: boolean; difference: string };
    };
    expect(parsed.matched).toHaveLength(7);
    expect(parsed.bridge.reconciled).toBe(true);
    expect(parsed.bridge.difference).toBe("0.00");
    expect(parsed.suggested[0]?.reasons.some((r) => r.startsWith("amount:"))).toBe(true);
  });
});

describe("import", () => {
  it("shows what the reader made of a file without needing a ledger", () => {
    const result = cli("import", "-s", "bank.csv");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Bank statement — CSV");
    expect(result.stdout).toContain("BGC SHARE CAPITAL");
  });

  it("emits JSON with one entry per line", () => {
    const parsed = JSON.parse(cli("import", "-s", "bank.csv", "--json").stdout) as {
      lines: unknown[];
      format: string;
    };
    expect(parsed.format).toBe("csv");
    expect(parsed.lines).toHaveLength(12);
  });
});

describe("accounts", () => {
  it("renders the chart", () => {
    const result = cli("accounts", "-l", "month.json");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("1110  Bank");
    expect(result.stdout).toContain("Assets");
  });

  it("says so when a ledger has no chart", () => {
    const result = cli("accounts", "-l", "no-chart.json");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no chart of accounts");
  });

  it("emits the chart as definitions in JSON", () => {
    const parsed = JSON.parse(cli("accounts", "-l", "month.json", "--json").stdout) as {
      code: string;
    }[];
    expect(parsed.some((account) => account.code === "1110")).toBe(true);
  });
});

describe("dashboard", () => {
  it("writes a self-contained page and says what it did", () => {
    const result = cli("dashboard", "-l", "month.json", "-s", "bank.csv", "-o", "dash.html");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Wrote dash.html");
    expect(result.stdout).toContain("7 matched, 2 to review");

    const html = WRITTEN["dash.html"] as string;
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain("window.__TALLYD__");
    expect(html.length).toBeGreaterThan(20_000);
  });

  it("requires somewhere to put it", () => {
    const result = cli("dashboard", "-l", "month.json", "-s", "bank.csv");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--out is required");
  });

  it("says so when the environment cannot write", () => {
    const result = run(
      ["dashboard", "-l", "month.json", "-s", "bank.csv", "-o", "dash.html"],
      readOnly,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("cannot write files");
  });

  it("exits 2 when the page it wrote will not balance", () => {
    const result = cli("dashboard", "-l", "month.json", "-s", "wrong-balance.csv", "-o", "bad.html");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("does not balance");
    expect(WRITTEN["bad.html"]).toBeDefined();
  });

  it("appears in the usage and has its own help", () => {
    expect(cli("--help").stdout).toContain("dashboard");
    expect(cli("dashboard", "--help").stdout).toContain("--out <file>");
  });
});

describe("failure handling", () => {
  it("turns a missing file into exit 1 on stderr, with nothing on stdout", () => {
    const result = cli("report", "-l", "nope.json");
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ENOENT");
  });

  it("turns a malformed document into exit 1", () => {
    const result = cli("report", "-l", "broken.json");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Not valid JSON");
  });

  it("rejects a mistyped flag rather than guessing", () => {
    const result = cli("report", "-l", "quarter.json", "--as-a", "2026-09-30");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown option: --as-a");
  });

  it("never writes results to stderr or errors to stdout", () => {
    const invocations = [
      ["report", "-l", "quarter.json"],
      ["report", "-l", "nope.json"],
      ["ageing", "-l", "quarter.json", "-a", "1130"],
      ["ageing", "-l", "quarter.json"],
      ["reconcile", "-l", "month.json", "-s", "bank.csv"],
      ["reconcile", "-l", "month.json", "-s", "wrong-balance.csv"],
      ["accounts", "-l", "no-chart.json"],
      ["frobnicate"],
    ];
    for (const argv of invocations) {
      const result = run(argv, environment);
      if (result.code === 1) expect(result.stdout).toBe("");
      if (result.stderr !== "") expect(result.stderr.endsWith("\n")).toBe(true);
    }
  });

  it("never throws, whatever it is given", () => {
    const nasty = [
      [],
      ["--"],
      ["report"],
      ["report", "--ledger"],
      ["reconcile", "-l", "month.json"],
      ["import"],
      ["ageing", "-l", "broken.json", "-a", "1130"],
      ["report", "-l", "quarter.json", "--as-at", "not-a-date"],
    ];
    for (const argv of nasty) {
      expect(() => run(argv, environment)).not.toThrow();
      expect(run(argv, environment).code).toBeGreaterThan(0);
    }
  });
});
