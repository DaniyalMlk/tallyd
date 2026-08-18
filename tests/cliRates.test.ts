import { describe, expect, it } from "vitest";
import { date } from "../src/ledger/index.js";
import { run, type CliEnvironment } from "../src/cli/run.js";
import { RateTable } from "../src/fx/table.js";
import { ratesToJson } from "../src/fx/document.js";

const CSV = [
  "Date,USD,GBP,CHF",
  "2026-03-09,1.0821,0.8400,0.9540",
  "2026-03-10,1.0829,0.8420,0.9545",
  "2026-03-11,1.0833,0.8440,0.9548",
  "2026-03-12,1.0835,0.8460,0.9549",
  "2026-03-13,1.0837,0.8473,0.9550",
].join("\n");

const JSON_RATES = ratesToJson(
  RateTable.of([
    { date: "2026-03-13", base: "EUR", quote: "GBP", rate: "0.8473", source: "ecb" },
    { date: "2026-03-13", base: "EUR", quote: "USD", rate: "1.0837", source: "ecb" },
  ]),
);

function harness(): CliEnvironment {
  const files: Record<string, string> = { "rates.csv": CSV, "rates.json": JSON_RATES };
  return {
    readFile: (path: string) => {
      const contents = files[path];
      if (contents === undefined) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      return contents;
    },
    today: () => date("2026-03-13"),
  };
}

describe("tallyd rates", () => {
  it("summarises a table when no pair is asked for", () => {
    const result = run(["rates", "-r", "rates.csv", "-b", "EUR"], harness());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("15 quotes over 3 pairs, 2026-03-09 to 2026-03-13");
    expect(result.stdout).toContain("EUR/GBP     5 quotes");
    expect(result.stdout).toContain("Currencies: CHF, EUR, GBP, USD");
  });

  it("summarises as JSON", () => {
    const result = run(["rates", "-r", "rates.csv", "-b", "EUR", "--json"], harness());
    expect(JSON.parse(result.stdout)).toMatchObject({
      quotes: 15,
      pairs: ["EUR/CHF", "EUR/GBP", "EUR/USD"],
      from: "2026-03-09",
      to: "2026-03-13",
      maxStaleDays: 4,
    });
  });

  it("reads the engine's own JSON format without being told which it is", () => {
    const result = run(["rates", "-r", "rates.json"], harness());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("2 quotes over 2 pairs");
    expect(result.stdout).toContain("EUR/GBP     1 quote ");
  });

  it("prices a pair on a date, and says the quote was published that day", () => {
    const result = run(
      ["rates", "-r", "rates.csv", "-b", "EUR", "-p", "EUR/GBP", "--on", "2026-03-13"],
      harness(),
    );
    expect(result.stdout).toContain("1 EUR = 0.847300 GBP on 2026-03-13");
    expect(result.stdout).toContain("direct quote from 2026-03-13");
    expect(result.stdout).toContain("published that day");
  });

  it("defaults the date to today", () => {
    const result = run(["rates", "-r", "rates.csv", "-b", "EUR", "-p", "EUR/GBP"], harness());
    expect(result.stdout).toContain("on 2026-03-13");
  });

  it("says how far back it had to reach", () => {
    const result = run(
      ["rates", "-r", "rates.csv", "-b", "EUR", "-p", "EUR/GBP", "--on", "2026-03-15"],
      harness(),
    );
    expect(result.stdout).toContain("2 days behind the date asked for");
  });

  it("shows the path when the price was triangulated", () => {
    const result = run(
      ["rates", "-r", "rates.csv", "-b", "EUR", "-p", "USD/GBP", "--on", "2026-03-13"],
      harness(),
    );
    expect(result.stdout).toContain("via USD -> EUR -> GBP");
    expect(result.stdout).toContain("1 USD = 0.781858 GBP");
  });

  it("converts an amount at the price it just quoted", () => {
    const result = run(
      [
        "rates",
        "-r",
        "rates.csv",
        "-b",
        "EUR",
        "-p",
        "EUR/GBP",
        "--on",
        "2026-03-13",
        "--amount",
        "1000.00",
      ],
      harness(),
    );
    expect(result.stdout).toContain("1000.00 EUR  ->  847.30 GBP");
  });

  it("reports the whole lookup as JSON", () => {
    const result = run(
      [
        "rates",
        "-r",
        "rates.csv",
        "-b",
        "EUR",
        "-p",
        "USD/GBP",
        "--on",
        "2026-03-14",
        "--amount",
        "5000.00",
        "--json",
      ],
      harness(),
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      pair: "USD/GBP",
      direct: false,
      via: ["USD", "EUR", "GBP"],
      staleDays: 1,
      converted: "3909.29",
      currency: "GBP",
    });
  });

  it("averages over a period", () => {
    const result = run(
      [
        "rates",
        "-r",
        "rates.csv",
        "-b",
        "EUR",
        "-p",
        "EUR/GBP",
        "--average",
        "2026-03-09:2026-03-15",
      ],
      harness(),
    );
    expect(result.stdout).toContain("0.844843  (daily, 7 observations)");
    expect(result.stdout).toContain("low 0.840000  high 0.847300");
  });

  it("takes the quoted average when asked for it", () => {
    const result = run(
      [
        "rates",
        "-r",
        "rates.csv",
        "-b",
        "EUR",
        "-p",
        "EUR/GBP",
        "--average",
        "2026-03-09:2026-03-15",
        "--method",
        "quoted",
      ],
      harness(),
    );
    expect(result.stdout).toContain("(quoted, 5 observations)");
  });

  it("widens the staleness bound on request", () => {
    const tight = run(
      ["rates", "-r", "rates.csv", "-b", "EUR", "-p", "EUR/GBP", "--on", "2026-04-01"],
      harness(),
    );
    expect(tight.code).toBe(1);
    expect(tight.stderr).toContain("stale");

    const patient = run(
      [
        "rates",
        "-r",
        "rates.csv",
        "-b",
        "EUR",
        "-p",
        "EUR/GBP",
        "--on",
        "2026-04-01",
        "--stale",
        "30",
      ],
      harness(),
    );
    expect(patient.code).toBe(0);
    expect(patient.stdout).toContain("19 days behind");
  });
});

describe("tallyd rates says what is wrong", () => {
  it("insists on a base currency for a CSV of bare columns", () => {
    const result = run(["rates", "-r", "rates.csv"], harness());
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("base currency must be given");
  });

  it("refuses a pair that is not BASE/QUOTE", () => {
    const result = run(["rates", "-r", "rates.csv", "-b", "EUR", "-p", "EURGBP"], harness());
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("BASE/QUOTE");
  });

  it("refuses a method it does not have", () => {
    const result = run(
      [
        "rates",
        "-r",
        "rates.csv",
        "-b",
        "EUR",
        "-p",
        "EUR/GBP",
        "--average",
        "2026-03-09:2026-03-13",
        "--method",
        "vwap",
      ],
      harness(),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("daily or quoted");
  });

  it("refuses an average range that is not from:to", () => {
    const result = run(
      ["rates", "-r", "rates.csv", "-b", "EUR", "-p", "EUR/GBP", "--average", "2026-03-09"],
      harness(),
    );
    expect(result.stderr).toContain("from:to");
  });

  it("refuses a staleness bound that is not a count of days", () => {
    const result = run(
      ["rates", "-r", "rates.csv", "-b", "EUR", "-p", "EUR/GBP", "--stale", "lots"],
      harness(),
    );
    expect(result.stderr).toContain("whole number of days");
  });

  it("names the pair it could not price", () => {
    const result = run(
      ["rates", "-r", "rates.json", "-p", "JPY/GBP", "--on", "2026-03-13"],
      harness(),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No JPY/GBP rate available");
  });

  it("reports a missing file rather than an empty table", () => {
    const result = run(["rates", "-r", "nowhere.csv", "-b", "EUR"], harness());
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("nowhere.csv");
  });

  it("lists rates in the command index and its own help", () => {
    expect(run(["--help"], harness()).stdout).toContain("rates");
    const help = run(["rates", "--help"], harness());
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--average");
    expect(help.stdout).toContain("--stale");
  });
});
