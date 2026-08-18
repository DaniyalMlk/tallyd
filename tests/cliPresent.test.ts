import { describe, expect, it } from "vitest";
import { date } from "../src/ledger/index.js";
import { run, type CliEnvironment } from "../src/cli/run.js";
import { JournalEntry } from "../src/ledger/entry.js";
import { Ledger } from "../src/ledger/ledger.js";
import { ledgerToJson } from "../src/ledger/serialise.js";
import { standardChart } from "../src/accounts/standard.js";
import { GBP } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";

const CHART = standardChart("GBP");

const BOOKS = ledgerToJson(
  Ledger.from(
    [
      JournalEntry.simple(
        {
          id: "JE-CAP",
          date: "2025-01-02",
          narration: "Share capital subscribed",
          debit: "1110",
          credit: "3100",
          amount: Money.parse("10000.00", GBP),
        },
        CHART,
      ),
      JournalEntry.simple(
        {
          id: "JE-SALE",
          date: "2026-06-30",
          narration: "Consulting revenue",
          debit: "1110",
          credit: "4200",
          amount: Money.parse("40000.00", GBP),
        },
        CHART,
      ),
      JournalEntry.simple(
        {
          id: "JE-RENT",
          date: "2026-06-30",
          narration: "Rent",
          debit: "5300",
          credit: "1110",
          amount: Money.parse("12000.00", GBP),
        },
        CHART,
      ),
    ],
    CHART,
  ),
);

const RATES_CSV = [
  "Date,USD",
  "2025-01-02,1.2000",
  "2026-01-01,1.2500",
  "2026-06-30,1.3000",
  "2026-12-31,1.3500",
].join("\n");

function harness(): CliEnvironment {
  const files: Record<string, string> = { "books.json": BOOKS, "usd.csv": RATES_CSV };
  return {
    readFile: (path: string) => {
      const contents = files[path];
      if (contents === undefined) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      return contents;
    },
    today: () => date("2026-12-31"),
  };
}

const ARGS = [
  "report",
  "-l",
  "books.json",
  "--as-at",
  "2026-12-31",
  "--from",
  "2026-01-01",
  "--to",
  "2026-12-31",
];

describe("tallyd report --present", () => {
  it("prints the presented statement after the ones in the books' own currency", () => {
    const result = run(
      [...ARGS, "-p", "USD", "-r", "usd.csv", "-b", "GBP", "--stale", "400"],
      harness(),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Trial balance as at 2026-12-31 (GBP)");
    expect(result.stdout).toContain("presented in USD (books kept in GBP)");
    expect(result.stdout.indexOf("Trial balance as at 2026-12-31 (GBP)")).toBeLessThan(
      result.stdout.indexOf("presented in USD"),
    );
  });

  it("names the rate every line took", () => {
    const result = run(
      [...ARGS, "-p", "USD", "-r", "usd.csv", "-b", "GBP", "--stale", "400"],
      harness(),
    );
    expect(result.stdout).toContain("Closing GBP/USD 1.350000");
    expect(result.stdout).toContain("daily average 1.275479");
    expect(result.stdout).toContain("Share Capital             historical");
    expect(result.stdout).toContain("Bank                      closing");
    expect(result.stdout).toContain("Consulting                average");
  });

  it("shows the translation adjustment as a line of its own", () => {
    const result = run(
      [...ARGS, "-p", "USD", "-r", "usd.csv", "-b", "GBP", "--stale", "400"],
      harness(),
    );
    expect(result.stdout).toContain("Translation adjustment    residual");
    expect(result.stdout).toContain("an equity item, not a profit");
  });

  it("reports the presented statement in JSON too", () => {
    const result = run(
      [...ARGS, "-p", "USD", "-r", "usd.csv", "-b", "GBP", "--stale", "400", "--json"],
      harness(),
    );
    const parsed = JSON.parse(result.stdout);
    expect(parsed.presented).toMatchObject({
      currency: "USD",
      averageMethod: "daily",
      translationAdjustment: "-3586.57",
    });
    expect(parsed.presented.totalDebit).toBe(parsed.presented.totalCredit);
    expect(parsed.presented.rows.find((r: { account: string }) => r.account === "3100")).toMatchObject(
      { basis: "historical", presentation: "-12000.00", rate: "1.2000000000" },
    );
  });

  it("leaves the report alone when --present is not given", () => {
    const result = run(ARGS, harness());
    expect(result.stdout).not.toContain("presented in");
    expect(JSON.parse(run([...ARGS, "--json"], harness()).stdout)).not.toHaveProperty("presented");
  });

  it("needs no rates at all to present into the books' own currency", () => {
    const result = run([...ARGS, "-p", "GBP"], harness());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("presented in GBP (books kept in GBP)");
    expect(result.stdout).not.toContain("Translation adjustment");
  });

  it("takes the closing rate for equity when asked", () => {
    const result = run(
      [...ARGS, "-p", "USD", "-r", "usd.csv", "-b", "GBP", "--stale", "400", "--equity", "closing"],
      harness(),
    );
    expect(result.stdout).toContain("Share Capital             closing");
  });

  it("takes the quoted average when asked", () => {
    const result = run(
      [
        ...ARGS,
        "-p",
        "USD",
        "-r",
        "usd.csv",
        "-b",
        "GBP",
        "--stale",
        "400",
        "--average-method",
        "quoted",
        "--json",
      ],
      harness(),
    );
    expect(JSON.parse(result.stdout).presented.averageMethod).toBe("quoted");
  });

  it("explains itself when equity reaches further back than the rates do", () => {
    const short = [
      "Date,USD",
      "2026-01-01,1.2500",
      "2026-06-30,1.3000",
      "2026-12-31,1.3500",
    ].join("\n");
    const files: Record<string, string> = { "books.json": BOOKS, "usd.csv": short };
    const environment: CliEnvironment = {
      readFile: (path: string) => files[path] as string,
      today: () => date("2026-12-31"),
    };
    const result = run(
      [...ARGS, "-p", "USD", "-r", "usd.csv", "-b", "GBP", "--stale", "400"],
      environment,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("JE-CAP");
    expect(result.stderr).toContain('equityBasis "closing"');
  });

  it("refuses an equity basis it does not have", () => {
    const result = run(
      [...ARGS, "-p", "USD", "-r", "usd.csv", "-b", "GBP", "--equity", "average"],
      harness(),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("historical or closing");
  });

  it("refuses an average method it does not have", () => {
    const result = run(
      [...ARGS, "-p", "USD", "-r", "usd.csv", "-b", "GBP", "--average-method", "vwap"],
      harness(),
    );
    expect(result.stderr).toContain("daily or quoted");
  });

  it("says which rate is missing rather than presenting a wrong number", () => {
    // Only a quote from two years before the balance sheet date, and the
    // default staleness bound is four days.
    const files: Record<string, string> = {
      "books.json": BOOKS,
      "usd.csv": "Date,USD\n2025-01-02,1.2000",
    };
    const environment: CliEnvironment = {
      readFile: (path: string) => files[path] as string,
      today: () => date("2026-12-31"),
    };
    const result = run(
      [...ARGS, "-p", "USD", "-r", "usd.csv", "-b", "GBP", "--equity", "closing"],
      environment,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No GBP/USD rate available on 2026-12-31");
  });

  it("averages over the part of the period the table can price", () => {
    // A period reaching back before the first quote is not an error: the
    // average is taken over the days there were rates for, and the closing
    // rate is what has to exist.
    const files: Record<string, string> = {
      "books.json": BOOKS,
      "usd.csv": "Date,USD\n2026-12-31,1.3500",
    };
    const environment: CliEnvironment = {
      readFile: (path: string) => files[path] as string,
      today: () => date("2026-12-31"),
    };
    const result = run(
      [...ARGS, "-p", "USD", "-r", "usd.csv", "-b", "GBP", "--equity", "closing", "--json"],
      environment,
    );
    expect(result.code).toBe(0);
    const presented = JSON.parse(result.stdout).presented;
    expect(presented.averageRate).toBe("1.3500000000");
    expect(presented.totalDebit).toBe(presented.totalCredit);
  });

  it("lists the new flags in its help", () => {
    const help = run(["report", "--help"], harness());
    expect(help.stdout).toContain("--present");
    expect(help.stdout).toContain("--equity");
    expect(help.stdout).toContain("--average-method");
  });
});
