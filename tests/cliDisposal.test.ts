import { describe, expect, it } from "vitest";
import { date } from "../src/ledger/index.js";
import { run, type CliEnvironment } from "../src/cli/run.js";
import { ledgerToJson } from "../src/ledger/serialise.js";
import { ratesToJson } from "../src/fx/document.js";
import { RateTable } from "../src/fx/table.js";
import {
  disposalLedgers,
  DISPOSAL_ACQUIRED,
  DISPOSAL_SOLD,
} from "../src/demo/disposal.js";

const DOCUMENT = {
  version: 1,
  name: "The Harrowgate Group",
  presentation: "GBP",
  asAt: "2026-12-31",
  period: { from: "2026-01-01", to: "2026-12-31" },
  entities: [
    { code: "HH", name: "Harrowgate Holdings", currency: "GBP", ledger: "hh.json" },
    {
      code: "PM",
      name: "Pellew Marine Ltd",
      currency: "GBP",
      parent: "HH",
      holding: "80",
      acquired: DISPOSAL_ACQUIRED,
      disposed: DISPOSAL_SOLD,
      ledger: "pm.json",
    },
  ],
  acquisitions: [{ entity: "PM", consideration: { amount: "400000.00", currency: "GBP" } }],
  disposals: [{ entity: "PM", proceeds: { amount: "600000.00", currency: "GBP" } }],
};

function harness(document: unknown = DOCUMENT): CliEnvironment {
  const ledgers = disposalLedgers();
  const files: Record<string, string> = {
    "group.json": JSON.stringify(document, null, 2),
    "hh.json": ledgerToJson(ledgers["HH"] as never),
    "pm.json": ledgerToJson(ledgers["PM"] as never),
    "rates.json": ratesToJson(RateTable.of([], { maxStaleDays: 5000 })),
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

describe("consolidating a group with a disposal", () => {
  const result = run(ARGS, harness());

  it("succeeds", () => {
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("says the company was sold when it renders the structure", () => {
    expect(result.stdout).toContain("sold 2026-09-30");
  });

  it("shows the window closing without being asked", () => {
    expect(result.stdout).toContain("2026-01-01 to 2026-09-30");
    expect(result.stdout).toContain("its balance sheet is read at 2026-09-30");
  });

  it("shows the disposal working beside the acquisition working", () => {
    expect(result.stdout).toContain("PM — acquired 2024-12-31");
    expect(result.stdout).toContain("PM — disposed of 2026-09-30");
    expect(result.stdout).toContain("Carrying amount");
  });

  it("shows the gain and the group total", () => {
    expect(result.stdout).toContain("Gain on disposal");
    expect(result.stdout).toContain("Gain on disposals");
    expect(result.stdout).toContain("80000.00");
  });

  it("warns that the holder's own books say something different", () => {
    expect(result.stdout).toContain("The holder's own books make it 200000.00");
  });
});

describe("the JSON it emits", () => {
  const parsed = JSON.parse(run([...ARGS, "--json"], harness()).stdout) as Record<string, unknown>;

  it("carries the disposals", () => {
    const disposals = parsed["disposals"] as Record<string, string>[];
    expect(disposals).toHaveLength(1);
    expect(disposals[0]?.["entity"]).toBe("PM");
    expect(disposals[0]?.["disposed"]).toBe("2026-09-30");
    expect(disposals[0]?.["carryingAmount"]).toBe("520000.00");
    expect(disposals[0]?.["result"]).toBe("80000.00");
    expect(disposals[0]?.["holderResult"]).toBe("200000.00");
  });

  it("carries the far end of each control window", () => {
    const windows = parsed["controlWindows"] as Record<string, unknown>[];
    const pm = windows.find((w) => w["entity"] === "PM");
    expect(pm?.["disposedDuring"]).toBe(true);
    expect(pm?.["readAt"]).toBe("2026-09-30");
    expect(pm?.["to"]).toBe("2026-09-30");
  });

  it("carries the totals", () => {
    expect(parsed["disposalResult"]).toBe("80000.00");
    expect(parsed["disposalResidual"]).toBe("0.00");
    expect(parsed["goodwill"]).toBe("0.00");
    expect(parsed["nonControllingInterest"]).toBe("0.00");
    expect(parsed["residual"]).toBe("0.00");
    expect(parsed["balanced"]).toBe(true);
  });
});

describe("the consolidated ledger it writes", () => {
  it("carries the disposal entry and loads back", () => {
    const environment = harness();
    const result = run([...ARGS, "-o", "out.json"], environment);
    expect(result.code).toBe(0);
    const written = JSON.parse(environment.readFile("out.json")) as {
      entries: { id: string; narration: string }[];
    };
    expect(written.entries.map((e) => e.id)).toContain("DISP-PM");
    const entry = written.entries.find((e) => e.id === "DISP-PM");
    expect(entry?.narration).toContain("Pellew Marine");
  });
});

describe("what the document refuses", () => {
  it("refuses a disposal for a company the entity list says is still held", () => {
    const document = {
      ...DOCUMENT,
      entities: DOCUMENT.entities.map((entity) =>
        entity.code === "PM" ? { ...entity, disposed: undefined } : entity,
      ),
    };
    const result = run(ARGS, harness(document));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('no "disposed" date on the entity');
  });

  it("refuses a disposal for a company that is not in the group", () => {
    const document = {
      ...DOCUMENT,
      disposals: [{ entity: "XX", proceeds: { amount: "1.00", currency: "GBP" } }],
    };
    const result = run(ARGS, harness(document));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not an entity in this group");
  });

  it("refuses a disposal with no proceeds", () => {
    const document = { ...DOCUMENT, disposals: [{ entity: "PM" }] };
    const result = run(ARGS, harness(document));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("The proceeds of PM");
  });

  it("refuses a disposals list that is not a list", () => {
    const document = { ...DOCUMENT, disposals: "none" };
    const result = run(ARGS, harness(document));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("disposals must be a list");
  });

  it("refuses a company sold before it was bought", () => {
    const document = {
      ...DOCUMENT,
      entities: DOCUMENT.entities.map((entity) =>
        entity.code === "PM" ? { ...entity, disposed: "2024-01-01" } : entity,
      ),
    };
    const result = run(ARGS, harness(document));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("before it was acquired");
  });

  it("refuses a disposal date that is not a date", () => {
    const document = {
      ...DOCUMENT,
      entities: DOCUMENT.entities.map((entity) =>
        entity.code === "PM" ? { ...entity, disposed: "the autumn" } : entity,
      ),
    };
    const result = run(ARGS, harness(document));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("disposal date");
  });
});

describe("a reporting date after the company had gone", () => {
  const result = run([
    ...ARGS,
    "--as-at",
    "2027-12-31",
    "--from",
    "2027-01-01",
    "--to",
    "2027-12-31",
  ], harness());

  it("consolidates the rest of the group without complaint", () => {
    expect(result.code).toBe(0);
  });

  it("says the company is no longer consolidated, and why", () => {
    expect(result.stdout).toContain("Not consolidated: PM");
    expect(result.stdout).toContain("before the period opened");
  });

  it("carries no goodwill and no outside stake", () => {
    const parsed = JSON.parse(
      run([
        ...ARGS,
        "--as-at",
        "2027-12-31",
        "--from",
        "2027-01-01",
        "--to",
        "2027-12-31",
        "--json",
      ], harness()).stdout,
    ) as Record<string, unknown>;
    expect(parsed["goodwill"]).toBe("0.00");
    expect(parsed["nonControllingInterest"]).toBe("0.00");
    expect(parsed["disposals"]).toEqual([]);
    expect(parsed["residual"]).toBe("0.00");
  });
});

describe("a comparative column spanning the sale", () => {
  const result = run([...ARGS, "--comparative", "2025-12-31"], harness());

  it("consolidates both dates", () => {
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("2025-12-31");
  });

  it("does not account for the sale in the year before it happened", () => {
    // The same document produces both columns, and the disposal belongs only
    // in the one whose period contains it.
    expect(result.stdout).not.toContain("does not balance");
  });

  it("carries the company in the prior column and not in the current one", () => {
    const parsed = JSON.parse(
      run([...ARGS, "--comparative", "2025-12-31", "--json"], harness()).stdout,
    ) as {
      comparative: {
        sound: boolean;
        rows: { account: string; current: string; prior: string }[];
        nonControllingInterest: { lines: { label: string; amount: string }[]; reconciles: boolean };
      };
    };
    const goodwill = parsed.comparative.rows.find((row) => row.account === "1290");
    expect(goodwill?.prior).toBe("120000.00");
    expect(goodwill?.current).toBe("0.00");
    const nci = parsed.comparative.rows.find((row) => row.account === "3400");
    expect(nci?.prior).toBe("-80000.00");
    expect(nci?.current).toBe("0.00");
  });
});

describe("the outside stake's roll-forward across a sale", () => {
  const parsed = JSON.parse(
    run([...ARGS, "--comparative", "2025-12-31", "--json"], harness()).stdout,
  ) as {
    comparative: {
      sound: boolean;
      nonControllingInterest: { lines: { label: string; amount: string }[]; reconciles: boolean };
    };
  };

  it("names the removal rather than leaving it unexplained", () => {
    const labels = parsed.comparative.nonControllingInterest.lines.map((line) => line.label);
    expect(labels).toContain("Removed with a company disposed of");
  });

  it("closes to nil and ties", () => {
    expect(parsed.comparative.nonControllingInterest.reconciles).toBe(true);
    expect(parsed.comparative.sound).toBe(true);
  });
});
