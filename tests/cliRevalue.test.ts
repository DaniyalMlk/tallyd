import { describe, expect, it } from "vitest";
import { date } from "../src/ledger/index.js";
import { run, type CliEnvironment } from "../src/cli/run.js";
import { ledgerFromJson, ledgerToJson } from "../src/ledger/serialise.js";
import { ratesToJson } from "../src/fx/document.js";
import { openItems } from "../src/fx/exposure.js";
import { foreignLedger, foreignRates } from "../src/demo/foreign.js";

function harness(): { environment: CliEnvironment; files: Record<string, string> } {
  const files: Record<string, string> = {
    "books.json": ledgerToJson(foreignLedger()),
    "rates.json": ratesToJson(foreignRates()),
    "rates.csv": ["Date,GBP", "2026-03-31,0.8600"].join("\n"),
  };
  return {
    files,
    environment: {
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
      today: () => date("2026-03-31"),
    },
  };
}

describe("tallyd revalue", () => {
  it("shows what is exposed without touching the rates", () => {
    const result = run(["revalue", "-l", "books.json", "--show"], harness().environment);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Foreign-currency balances (books kept in GBP)");
    expect(result.stdout).toContain("1500.00 EUR");
    expect(result.stdout).toContain("-500.00 USD");
  });

  it("shows the exposures as JSON", () => {
    const result = run(
      ["revalue", "-l", "books.json", "--show", "--json"],
      harness().environment,
    );
    const parsed = JSON.parse(result.stdout);
    expect(parsed.functional).toBe("GBP");
    expect(parsed.exposures).toHaveLength(2);
    expect(parsed.exposures[0]).toMatchObject({
      account: "1131",
      currency: "EUR",
      foreignBalance: "1500.00",
      carryingAmount: "1265.00",
    });
  });

  it("retranslates each open item and reports the net", () => {
    const result = run(
      ["revalue", "-l", "books.json", "-r", "rates.json", "--as-at", "2026-03-31"],
      harness().environment,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Revaluation at 2026-03-31 (books kept in GBP)");
    expect(result.stdout).toContain("Receivable (EUR) / INV-014");
    expect(result.stdout).toContain("Net unrealised gain of 30.00 GBP");
    expect(result.stdout).toContain("Nothing was written. Pass --out to apply it.");
  });

  it("writes nothing unless told to", () => {
    const { environment, files } = harness();
    run(["revalue", "-l", "books.json", "-r", "rates.json"], environment);
    expect(Object.keys(files)).not.toContain("after.json");
  });

  it("applies the entry when given somewhere to put it", () => {
    const { environment, files } = harness();
    const result = run(
      ["revalue", "-l", "books.json", "-r", "rates.json", "-o", "after.json"],
      environment,
    );
    expect(result.stdout).toContain("Wrote after.json with FX-REVAL-2026-03-31 applied.");

    const after = ledgerFromJson(files["after.json"] as string);
    expect(after.has("FX-REVAL-2026-03-31")).toBe(true);
    for (const item of openItems(after)) {
      expect(item.impliedRate?.toDecimalString(4)).toBe(
        item.currency.code === "EUR" ? "0.8600" : "0.7700",
      );
    }
  });

  it("is a no-op the second time round", () => {
    const { environment, files } = harness();
    run(["revalue", "-l", "books.json", "-r", "rates.json", "-o", "after.json"], environment);
    files["books.json"] = files["after.json"] as string;
    const again = run(
      ["revalue", "-l", "books.json", "-r", "rates.json", "-o", "again.json"],
      environment,
    );
    expect(again.stdout).toContain("already carried at the closing rate");
    expect(again.stdout).toContain("Wrote again.json unchanged.");
  });

  it("reports the whole revaluation as JSON", () => {
    const result = run(
      ["revalue", "-l", "books.json", "-r", "rates.json", "--json"],
      harness().environment,
    );
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({ asAt: "2026-03-31", net: "30.00", entry: "FX-REVAL-2026-03-31" });
    expect(parsed.lines).toHaveLength(3);
    expect(parsed.lines[0]).toMatchObject({ account: "1131", adjustment: "20.00" });
  });

  it("leaves out the accounts it is told to", () => {
    const result = run(
      ["revalue", "-l", "books.json", "-r", "rates.json", "--exclude", "2101", "--json"],
      harness().environment,
    );
    expect(JSON.parse(result.stdout).net).toBe("25.00");
  });

  it("takes a different pair of gain and loss accounts", () => {
    const result = run(
      [
        "revalue",
        "-l",
        "books.json",
        "-r",
        "rates.json",
        "--gain",
        "4300",
        "--loss",
        "5800",
        "-o",
        "after.json",
      ],
      harness().environment,
    );
    expect(result.code).toBe(0);
  });

  it("reads a wide CSV of rates, given the base currency", () => {
    const result = run(
      ["revalue", "-l", "books.json", "-r", "rates.csv", "-b", "EUR", "--exclude", "2101"],
      harness().environment,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Net unrealised gain of 25.00 GBP");
  });

  it("says which rate it could not find", () => {
    const result = run(
      ["revalue", "-l", "books.json", "-r", "rates.csv", "-b", "EUR"],
      harness().environment,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No USD/GBP rate available");
  });

  it("refuses a gain account the chart cannot post to", () => {
    const result = run(
      ["revalue", "-l", "books.json", "-r", "rates.json", "--gain", "4000"],
      harness().environment,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not one this chart can post to");
  });

  it("refuses to widen the staleness bound with something that is not a count", () => {
    const result = run(
      ["revalue", "-l", "books.json", "-r", "rates.json", "--stale", "ages"],
      harness().environment,
    );
    expect(result.stderr).toContain("whole number of days");
  });

  it("says so in a read-only environment rather than half-doing it", () => {
    const { environment } = harness();
    const readOnly: CliEnvironment = {
      readFile: environment.readFile,
      today: environment.today,
    };
    const result = run(
      ["revalue", "-l", "books.json", "-r", "rates.json", "-o", "after.json"],
      readOnly,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("cannot write files");
  });

  it("appears in the command index and has its own help", () => {
    expect(run(["--help"], harness().environment).stdout).toContain("revalue");
    const help = run(["revalue", "--help"], harness().environment);
    expect(help.stdout).toContain("--as-at");
    expect(help.stdout).toContain("--exclude");
  });
});
