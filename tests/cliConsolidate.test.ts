import { describe, expect, it } from "vitest";
import { date } from "../src/ledger/index.js";
import { run, type CliEnvironment } from "../src/cli/run.js";
import { ledgerFromJson, ledgerToJson } from "../src/ledger/serialise.js";
import { ratesToJson } from "../src/fx/document.js";
import { GroupDocumentError, groupFromJson } from "../src/group/document.js";
import { GroupError } from "../src/group/structure.js";
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

function harness(document: unknown = GROUP_DOCUMENT): {
  environment: CliEnvironment;
  files: Record<string, string>;
} {
  const ledgers = groupLedgers();
  const files: Record<string, string> = {
    "group.json": JSON.stringify(document, null, 2),
    "hh.json": ledgerToJson(ledgers["HH"]!),
    "hn.json": ledgerToJson(ledgers["HN"]!),
    "hs.json": ledgerToJson(ledgers["HS"]!),
    "rates.json": ratesToJson(groupRates()),
    "broken.json": "{not json",
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
      today: () => date("2026-12-31"),
    },
  };
}

const ARGS = ["consolidate", "-g", "group.json", "-r", "rates.json", "--stale", "400"];

describe("tallyd consolidate", () => {
  it("runs the group end to end and comes out balanced", () => {
    const result = run(ARGS, harness().environment);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("The Halden Group — consolidated as at 2026-12-31 in GBP");
    expect(result.stdout).toContain("Accounting equation residual");
    expect(result.stdout).not.toContain("DOES NOT BALANCE");
  });

  it("shows the ownership, including the interest held through another company", () => {
    const result = run(ARGS, harness().environment);
    expect(result.stdout).toContain("80% owned, 20% outside");
    expect(result.stdout).toContain("60% owned, 40% outside");
  });

  it("shows the acquisition workings by default", () => {
    const result = run(ARGS, harness().environment);
    expect(result.stdout).toContain("Consideration transferred");
    expect(result.stdout).toContain("non-controlling interest at fair-value");
    expect(result.stdout).toContain("of which attributable to the outside stake");
  });

  it("shows the combined trial balance when asked", () => {
    const result = run([...ARGS, "--show", "combined"], harness().environment);
    expect(result.stdout).toContain("Combined trial balance as at 2026-12-31 (GBP), 3 entities");
    expect(result.stdout).not.toContain("Consideration transferred");
  });

  it("shows the eliminations when asked", () => {
    const result = run([...ARGS, "--show", "eliminations"], harness().environment);
    expect(result.stdout).toContain("Intercompany eliminations — 2 pairs");
    expect(result.stdout).toContain("carried as items in transit rather than plugged");
  });

  it("shows the statements when asked", () => {
    const result = run([...ARGS, "--show", "statements"], harness().environment);
    expect(result.stdout).toContain("Trial balance as at 2026-12-31 (GBP)");
    expect(result.stdout).toContain("Income statement (GBP)");
    expect(result.stdout).toContain("Balance sheet (GBP) as at 2026-12-31");
    expect(result.stdout).toContain("Non-controlling Interest");
  });

  it("refuses a --show it does not know", () => {
    const result = run([...ARGS, "--show", "everything"], harness().environment);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--show wants one of");
  });

  it("emits the workings as JSON", () => {
    const result = run([...ARGS, "--json"], harness().environment);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload["presentation"]).toBe("GBP");
    expect(payload["balanced"]).toBe(true);
    expect(payload["residual"]).toBe("0.00");
    const entities = payload["entities"] as { code: string; nonControllingInterest: string }[];
    expect(entities.map((e) => e.code)).toEqual(["HH", "HN", "HS"]);
    expect(entities.find((e) => e.code === "HS")?.nonControllingInterest).toBe("40%");
    const workings = payload["workings"] as { entity: string; goodwill: string }[];
    expect(workings.map((w) => w.entity)).toEqual(["HN", "HS"]);
    expect(workings.find((w) => w.entity === "HN")?.goodwill).toBe("54080.00");
  });

  it("writes the consolidated ledger as a document that reads back", () => {
    const { environment, files } = harness();
    const result = run([...ARGS, "--out", "group-books.json"], environment);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Wrote the consolidated ledger to group-books.json");
    const reloaded = ledgerFromJson(files["group-books.json"] as string);
    reloaded.verify();
    expect(reloaded.size).toBe(9);
    expect(reloaded.balanceOf("1290", "GBP").toDecimalString()).toBe("113436.00");
    expect(reloaded.balanceOf("3400", "GBP").toDecimalString()).toBe("-174052.58");
  });

  it("takes the reporting date and period from the flags over the document", () => {
    const result = run(
      [...ARGS, "--as-at", "2025-12-31", "--from", "2025-01-01", "--to", "2025-12-31", "--json"],
      harness().environment,
    );
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload["asAt"]).toBe("2025-12-31");
    expect(payload["balanced"]).toBe(true);
  });

  it("insists on rates when the group keeps books in more than one currency", () => {
    const result = run(["consolidate", "-g", "group.json"], harness().environment);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("needs --rates");
    expect(result.stderr).toContain("EUR");
  });

  it("says which entity has no books rather than failing halfway", () => {
    const withoutLedger = {
      ...GROUP_DOCUMENT,
      entities: GROUP_DOCUMENT.entities.map((e) =>
        e.code === "HS" ? { ...e, ledger: undefined } : e,
      ),
    };
    const result = run(ARGS, harness(withoutLedger).environment);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("HS has no");
    expect(result.stderr).toContain("no books to consolidate");
  });

  it("reports a broken group document as a usage problem", () => {
    const result = run(["consolidate", "-g", "broken.json"], harness().environment);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not valid JSON");
  });

  it("reports a structural problem in the document by name", () => {
    const cyclic = {
      ...GROUP_DOCUMENT,
      entities: [
        { code: "A", name: "A", currency: "GBP", parent: "B", ledger: "hh.json" },
        { code: "B", name: "B", currency: "GBP", parent: "A", ledger: "hh.json" },
      ],
    };
    const result = run(ARGS, harness(cyclic).environment);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("cycle");
  });

  it("reports a missing acquisition as a usage problem, not a crash", () => {
    const noAcquisitions = { ...GROUP_DOCUMENT, acquisitions: [] };
    const result = run(ARGS, harness(noAcquisitions).environment);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No acquisition for HN, HS");
  });

  it("lists itself in the usage text and has help of its own", () => {
    const usage = run([], harness().environment);
    expect(usage.stdout).toContain("consolidate");
    const help = run(["consolidate", "--help"], harness().environment);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Group document (JSON)");
    expect(help.stdout).toContain("--show");
  });
});

describe("the group document", () => {
  it("reads the entities, the declarations and the acquisitions", () => {
    const parsed = groupFromJson(JSON.stringify(GROUP_DOCUMENT));
    expect(parsed.structure.order).toEqual(["HH", "HN", "HS"]);
    expect(parsed.structure.effectiveInterest("HS").toPercentString()).toBe("60%");
    expect(parsed.ledgers.get("HN")).toBe("hn.json");
    expect(parsed.intercompany).toHaveLength(4);
    expect(parsed.acquisitions).toHaveLength(2);
    expect(parsed.acquisitions[1]?.nciFairValue?.toDecimalString()).toBe("72000.00");
    expect(parsed.asAt).toBe("2026-12-31");
    expect(parsed.period?.from).toBe("2026-01-01");
    expect(parsed.averageMethod).toBe("daily");
  });

  it("reads the general form of a holding", () => {
    const parsed = groupFromJson(
      JSON.stringify({
        presentation: "GBP",
        entities: [
          { code: "P", currency: "GBP" },
          { code: "S", currency: "GBP", parent: "P", holding: "80" },
          {
            code: "T",
            currency: "GBP",
            heldBy: [
              { holder: "P", interest: "20" },
              { holder: "S", interest: "60" },
            ],
          },
        ],
      }),
    );
    expect(parsed.structure.effectiveInterest("T").toPercentString()).toBe("68%");
    // A code with no name is named after itself rather than left blank.
    expect(parsed.structure.get("T").name).toBe("T");
  });

  it("keeps a non-terminating holding exact through the file", () => {
    const parsed = groupFromJson(
      JSON.stringify({
        presentation: "GBP",
        entities: [
          { code: "P", currency: "GBP" },
          { code: "S", currency: "GBP", parent: "P", holding: "2/3" },
        ],
      }),
    );
    expect(parsed.structure.effectiveInterest("S").toRatioString()).toBe("2/3");
  });

  it("says what is wrong with it rather than throwing something generic", () => {
    expect(() => groupFromJson("[]")).toThrow(GroupDocumentError);
    expect(() => groupFromJson('{"entities": []}')).toThrow(/non-empty list of entities/);
    expect(() => groupFromJson('{"entities": [{"code": "P"}]}')).toThrow(/currency/);
    expect(() =>
      groupFromJson('{"entities": [{"code": "P", "currency": "GBP", "acquired": "yesterday"}]}'),
    ).toThrow(/is not a date/);
  });

  it("refuses a measurement basis it does not have", () => {
    expect(() =>
      groupFromJson(
        JSON.stringify({
          entities: [
            { code: "P", currency: "GBP" },
            { code: "S", currency: "GBP", parent: "P", acquired: "2025-01-01" },
          ],
          acquisitions: [
            {
              entity: "S",
              consideration: { amount: "1.00", currency: "GBP" },
              nciMeasurement: "guesswork",
            },
          ],
        }),
      ),
    ).toThrow(/"proportionate" or "fair-value"/);
  });

  it("refuses an amount that is not written as an amount", () => {
    expect(() =>
      groupFromJson(
        JSON.stringify({
          entities: [
            { code: "P", currency: "GBP" },
            { code: "S", currency: "GBP", parent: "P", acquired: "2025-01-01" },
          ],
          acquisitions: [{ entity: "S", consideration: "1.00" }],
        }),
      ),
    ).toThrow(/"amount".*"currency"/);
  });

  it("lets the structure's own validation through unchanged", () => {
    expect(() =>
      groupFromJson(
        JSON.stringify({
          entities: [
            { code: "P", currency: "GBP" },
            { code: "S", currency: "GBP", parent: "nobody" },
          ],
        }),
      ),
    ).toThrow(GroupError);
  });

  it("refuses an average method or equity basis it does not have", () => {
    const base = { entities: [{ code: "P", currency: "GBP" }] };
    expect(() => groupFromJson(JSON.stringify({ ...base, averageMethod: "weekly" }))).toThrow(
      /"daily" or "quoted"/,
    );
    expect(() => groupFromJson(JSON.stringify({ ...base, equityBasis: "opening" }))).toThrow(
      /"historical" or "closing"/,
    );
  });
});
