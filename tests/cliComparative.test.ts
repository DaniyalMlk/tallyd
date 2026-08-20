import { describe, expect, it } from "vitest";
import { date } from "../src/ledger/index.js";
import { run, type CliEnvironment } from "../src/cli/run.js";
import { ledgerToJson } from "../src/ledger/serialise.js";
import { ratesToJson } from "../src/fx/document.js";
import { groupLedgers, groupRates } from "../src/demo/group.js";

const GROUP_DOCUMENT = {
  version: 1,
  name: "The Halden Group",
  presentation: "GBP",
  asAt: "2026-12-31",
  period: { from: "2026-01-01", to: "2026-12-31" },
  averageMethod: "daily",
  entities: [
    { code: "HH", name: "Halden Holdings", currency: "GBP", ledger: "hh.json" },
    {
      code: "HN",
      name: "Halden Nord GmbH",
      currency: "EUR",
      parent: "HH",
      holding: "80",
      acquired: "2025-01-02",
      ledger: "hn.json",
    },
    {
      code: "HS",
      name: "Halden Systems Inc",
      currency: "USD",
      parent: "HN",
      holding: "75",
      acquired: "2025-01-02",
      ledger: "hs.json",
    },
  ],
  intercompany: [
    { entity: "HH", account: "1190", counterparty: "HN", link: "loan" },
    { entity: "HN", account: "2190", counterparty: "HH", link: "loan" },
    { entity: "HH", account: "4950", counterparty: "HN", link: "trading" },
    { entity: "HN", account: "5960", counterparty: "HH", link: "trading" },
  ],
  acquisitions: [
    { entity: "HN", consideration: { amount: "260000.00", currency: "GBP" } },
    {
      entity: "HS",
      consideration: { amount: "150000.00", currency: "EUR" },
      nciMeasurement: "fair-value",
      nciFairValue: { amount: "72000.00", currency: "USD" },
    },
  ],
};

function harness(document: unknown = GROUP_DOCUMENT): CliEnvironment {
  const ledgers = groupLedgers();
  const files: Record<string, string> = {
    "group.json": JSON.stringify(document, null, 2),
    "hh.json": ledgerToJson(ledgers["HH"] as never),
    "hn.json": ledgerToJson(ledgers["HN"] as never),
    "hs.json": ledgerToJson(ledgers["HS"] as never),
    "rates.json": ratesToJson(groupRates()),
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

const BASE = ["consolidate", "-g", "group.json", "-r", "rates.json", "--stale", "400"];
const WITH_COMPARATIVE = [...BASE, "--comparative", "2025-12-31"];

describe("tallyd consolidate --comparative", () => {
  it("runs both dates and comes out balanced on each", () => {
    const result = run(WITH_COMPARATIVE, harness());
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("with 2025-12-31 beside it (GBP)");
  });

  it("prints nothing extra without the flag", () => {
    const result = run(BASE, harness());
    expect(result.stdout).not.toContain("beside it");
    expect(result.stdout).not.toContain("Movement in net assets");
    expect(result.stdout).not.toContain("At the start of the period");
  });

  it("carries both columns and the movement between them", () => {
    const result = run(WITH_COMPARATIVE, harness());
    const line = result.stdout.split("\n").find((l) => l.startsWith("1290"));
    expect(line).toContain("113436.00");
    // Goodwill did not move, so the movement column is nil on that row.
    expect(line?.trimEnd().endsWith("0.00")).toBe(true);
  });

  it("shows the outside stake and the reserve rolled forward", () => {
    const result = run(WITH_COMPARATIVE, harness());
    expect(result.stdout).toContain("Non-controlling interest");
    expect(result.stdout).toContain("Share of the result for the period");
    expect(result.stdout).toContain("Share of the translation effect");
    expect(result.stdout).toContain("HN — movement on retranslation");
    expect(result.stdout).not.toContain("Not explained by the above");
  });

  it("defaults the comparative period to one of the same length", () => {
    // 2026-01-01 to 2026-12-31 is 364 days, so the comparative runs
    // 2025-01-01 to 2025-12-31 and the prior reserve is the one that year
    // produced, not one measured over a period of some other length.
    const derived = run(WITH_COMPARATIVE, harness());
    const stated = run([...WITH_COMPARATIVE, "--comparative-from", "2025-01-01"], harness());
    expect(derived.stdout).toBe(stated.stdout);
  });

  it("takes a comparative period of a different length when told", () => {
    const half = run([...WITH_COMPARATIVE, "--comparative-from", "2025-07-01"], harness());
    expect(half.code).toBe(0);
    // And on these books it changes nothing, which is worth pinning down
    // rather than leaving to be discovered. The comparative period only
    // decides the average rate, the average rate only touches income and
    // expense, and these books were closed to reserves at 2025-12-31 — so
    // there is no income left at that date for any rate to be applied to.
    // Books that have never been closed would behave quite differently, and
    // that is the same limitation the whole consolidation carries: an entity's
    // result is read as a balance at a date rather than as a movement over a
    // period.
    expect(half.stdout).toBe(run(WITH_COMPARATIVE, harness()).stdout);
  });

  it("refuses a comparative date that is not before the reporting date", () => {
    const same = run([...BASE, "--comparative", "2026-12-31"], harness());
    expect(same.code).toBe(1);
    expect(same.stderr).toContain("not before the reporting date");
    const later = run([...BASE, "--comparative", "2027-06-30"], harness());
    expect(later.code).toBe(1);
    expect(later.stderr).toContain("not before the reporting date");
  });

  it("names movement as a thing --show accepts", () => {
    const result = run([...WITH_COMPARATIVE, "--show", "movement"], harness());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Movement in net assets");
    expect(result.stdout).not.toContain("Consideration transferred");
  });

  it("still rejects a --show it does not know", () => {
    const result = run([...WITH_COMPARATIVE, "--show", "sideways"], harness());
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("movement");
  });

  it("lists the flag in its own help", () => {
    const help = run(["consolidate", "--help"], harness());
    expect(help.stdout).toContain("--comparative <date>");
    expect(help.stdout).toContain("--comparative-from <date>");
  });
});

describe("the comparative as JSON", () => {
  const parsed = () =>
    JSON.parse(run([...WITH_COMPARATIVE, "--json"], harness()).stdout) as Record<string, unknown>;

  it("is absent unless a comparative was asked for", () => {
    const plain = JSON.parse(run([...BASE, "--json"], harness()).stdout) as Record<string, unknown>;
    expect(plain["comparative"]).toBeUndefined();
  });

  it("carries the comparative date and whether it hangs together", () => {
    const comparative = parsed()["comparative"] as unknown as Record<string, unknown>;
    expect(comparative["asAt"]).toBe("2025-12-31");
    expect(comparative["sound"]).toBe(true);
    expect(comparative["entered"]).toEqual([]);
    expect(comparative["left"]).toEqual([]);
  });

  it("carries a row per account with both columns", () => {
    const comparative = parsed()["comparative"] as unknown as Record<string, unknown>;
    const rows = comparative["rows"] as { account: string; current: string; prior: string }[];
    const goodwill = rows.find((r) => r.account === "1290");
    expect(goodwill?.current).toBe("113436.00");
    expect(goodwill?.prior).toBe("113436.00");
  });

  it("carries the net-asset decomposition per entity", () => {
    const comparative = parsed()["comparative"] as unknown as Record<string, unknown>;
    const movements = comparative["netAssets"] as Record<string, string>[];
    expect(movements.map((m) => m["entity"])).toEqual(["HN", "HS"]);
    const systems = movements.find((m) => m["entity"] === "HS") as Record<string, string>;
    expect(systems["translationEffect"]).toBe("-4900.00");
    expect(systems["result"]).toBe("57999.46");
    expect(systems["other"]).toBe("-999.46");
  });

  it("carries each schedule with its unexplained line, even when it is nil", () => {
    const comparative = parsed()["comparative"] as unknown as Record<string, unknown>;
    const stake = comparative["nonControllingInterest"] as Record<string, unknown>;
    expect(stake["opening"]).toBe("152864.00");
    expect(stake["closing"]).toBe("174052.58");
    expect(stake["unexplained"]).toBe("0.00");
    expect(stake["reconciles"]).toBe(true);
    expect((stake["lines"] as unknown[]).length).toBeGreaterThan(0);

    const reserve = comparative["translationReserve"] as Record<string, unknown>;
    expect(reserve["what"]).toBe("Translation reserve");
    expect(reserve["closing"]).toBe("-22164.01");
  });

  it("leaves the single-date figures exactly where they were", () => {
    const both = parsed();
    const plain = JSON.parse(run([...BASE, "--json"], harness()).stdout) as Record<string, unknown>;
    expect(both["goodwill"]).toBe(plain["goodwill"]);
    expect(both["nonControllingInterest"]).toBe(plain["nonControllingInterest"]);
    expect(both["residual"]).toBe(plain["residual"]);
  });
});
