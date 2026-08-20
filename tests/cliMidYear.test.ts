import { describe, expect, it } from "vitest";
import { date } from "../src/ledger/index.js";
import { run, type CliEnvironment } from "../src/cli/run.js";
import { ledgerToJson } from "../src/ledger/serialise.js";
import { ratesToJson } from "../src/fx/document.js";
import { RateTable } from "../src/fx/table.js";
import { midYearLedgers, MID_YEAR_ACQUIRED } from "../src/demo/midYear.js";
import { groupLedgers, groupRates } from "../src/demo/group.js";

const MID_YEAR_DOCUMENT = {
  version: 1,
  name: "The Fenwick Group",
  presentation: "GBP",
  asAt: "2026-12-31",
  period: { from: "2026-01-01", to: "2026-12-31" },
  entities: [
    { code: "FG", name: "Fenwick Group", currency: "GBP", ledger: "fg.json" },
    {
      code: "AL",
      name: "Aldermere Ltd",
      currency: "GBP",
      parent: "FG",
      holding: "75",
      acquired: MID_YEAR_ACQUIRED,
      ledger: "al.json",
    },
  ],
  acquisitions: [{ entity: "AL", consideration: { amount: "260000.00", currency: "GBP" } }],
};

function harness(document: unknown = MID_YEAR_DOCUMENT): CliEnvironment {
  const ledgers = midYearLedgers();
  const halden = groupLedgers();
  const files: Record<string, string> = {
    "group.json": JSON.stringify(document, null, 2),
    "fg.json": ledgerToJson(ledgers["FG"] as never),
    "al.json": ledgerToJson(ledgers["AL"] as never),
    "hh.json": ledgerToJson(halden["HH"] as never),
    "hn.json": ledgerToJson(halden["HN"] as never),
    "hs.json": ledgerToJson(halden["HS"] as never),
    "rates.json": ratesToJson(RateTable.of([], { maxStaleDays: 5000 })),
    "haldenRates.json": ratesToJson(groupRates()),
  };
  return {
    readFile: (path: string) => {
      const contents = files[path];
      if (contents === undefined) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      return contents;
    },
    writeFile: (path: string, contents: string) => {
      files[path] = contents;
    },
    today: () => date("2026-12-31"),
  };
}

const ARGS = ["consolidate", "-g", "group.json"];

describe("consolidating a group that bought a company in April", () => {
  it("runs from a group document and balances", () => {
    const result = run(ARGS, harness());
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Accounting equation residual");
  });

  it("takes the acquisition date from the entity, with nothing extra to pass", () => {
    const result = run(ARGS, harness());
    expect(result.stdout).toContain("Consolidated from 2026-04-02, not from 2026-01-01");
    expect(result.stdout).toContain("Result for the period");
  });

  it("shows nine months of result, not twelve", () => {
    const result = run(ARGS, harness());
    const line = result.stdout.split("\n").find((l) => l.includes("Result for the period"));
    expect(line).toContain("120000.00");
    expect(line).not.toContain("180000.00");
  });

  it("prints the windows without being asked, because they change how to read it", () => {
    const result = run(ARGS, harness());
    expect(result.stdout).toContain("How much of the period each company was the group's");
    expect(result.stdout).toContain("2026-04-02 to 2026-12-31");
  });

  it("says nothing about windows on a group that held everything all period", () => {
    const halden = {
      version: 1,
      name: "The Halden Group",
      presentation: "GBP",
      asAt: "2026-12-31",
      period: { from: "2026-01-01", to: "2026-12-31" },
      entities: [
        { code: "HH", name: "Halden Holdings", currency: "GBP", ledger: "hh.json" },
        { code: "HN", name: "Halden Nord GmbH", currency: "EUR", parent: "HH", holding: "80", acquired: "2025-01-02", ledger: "hn.json" },
        { code: "HS", name: "Halden Systems Inc", currency: "USD", parent: "HN", holding: "75", acquired: "2025-01-02", ledger: "hs.json" },
      ],
      acquisitions: [
        { entity: "HN", consideration: { amount: "260000.00", currency: "GBP" } },
        { entity: "HS", consideration: { amount: "150000.00", currency: "EUR" } },
      ],
    };
    const result = run(
      ["consolidate", "-g", "group.json", "-r", "haldenRates.json", "--stale", "400"],
      harness(halden),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("How much of the period each company");
  });

  it("shows them on demand even then", () => {
    const result = run([...ARGS, "--show", "windows"], harness());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("How much of the period each company was the group's");
  });

  it("refuses a company acquired after the reporting date", () => {
    const later = {
      ...MID_YEAR_DOCUMENT,
      entities: [
        MID_YEAR_DOCUMENT.entities[0],
        { ...MID_YEAR_DOCUMENT.entities[1], acquired: "2027-04-01" },
      ],
    };
    const result = run(ARGS, harness(later));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("after the reporting date");
  });
});

describe("the windows as JSON", () => {
  const parsed = () => JSON.parse(run([...ARGS, "--json"], harness()).stdout) as Record<string, unknown>;

  it("carries one entry per consolidated entity", () => {
    const windows = parsed()["controlWindows"] as Record<string, unknown>[];
    expect(windows.map((w) => w["entity"])).toEqual(["FG", "AL"]);
  });

  it("says which part of the period each covered, and why", () => {
    const windows = parsed()["controlWindows"] as Record<string, unknown>[];
    const parent = windows.find((w) => w["entity"] === "FG") as Record<string, unknown>;
    const sub = windows.find((w) => w["entity"] === "AL") as Record<string, unknown>;
    expect(parent["whole"]).toBe(true);
    expect(sub["whole"]).toBe(false);
    expect(sub["from"]).toBe("2026-04-02");
    expect(sub["to"]).toBe("2026-12-31");
    expect(sub["acquiredDuring"]).toBe(true);
    expect(sub["applied"]).toBe(true);
    expect(sub["reason"]).toContain("part-way through the period");
  });

  it("carries the result that was left with the seller", () => {
    const windows = parsed()["controlWindows"] as Record<string, unknown>[];
    const sub = windows.find((w) => w["entity"] === "AL") as Record<string, unknown>;
    expect(sub["preAcquisitionResult"]).toBe("60000.00");
  });

  it("agrees with the workings on what the group earned", () => {
    const workings = parsed()["workings"] as Record<string, unknown>[];
    expect(workings[0]?.["profitForPeriod"]).toBe("120000.00");
    expect(workings[0]?.["nciProfitShare"]).toBe("30000.00");
  });
});
