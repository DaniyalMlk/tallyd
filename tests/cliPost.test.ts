import { describe, expect, it } from "vitest";
import { date } from "../src/ledger/index.js";
import { ledgerFromJson, ledgerToJson } from "../src/ledger/serialise.js";
import { trialBalance } from "../src/ledger/trialBalance.js";
import { run, type CliEnvironment } from "../src/cli/run.js";
import { demoLedger } from "../src/demo/month.js";
import { DEMO_BANK_CSV } from "../src/demo/statement.js";
import { GBP } from "../src/money/index.js";
import { importCsv } from "../src/statement/import.js";
import { bankView } from "../src/reconcile/bankView.js";
import { reconcile } from "../src/reconcile/matcher.js";

/**
 * The demo month, plus the three statement lines the books have never heard
 * of: a bank charge, some interest, and a direct debit nobody entered. Those
 * are exactly the lines `post` exists for.
 */
const EXTRA_CSV = [
  DEMO_BANK_CSV.trimEnd(),
  "31/08/2026,ACCOUNT MAINTENANCE FEE,6.50,,",
  "31/08/2026,GROSS INTEREST,,3.10,",
  "28/08/2026,DD PROPERTY RENT,950.00,,",
  "29/08/2026,FPO NOBODY KNOWS 8821,412.00,,",
].join("\n");

function harness(seed: Record<string, string> = {}): {
  environment: CliEnvironment;
  files: Record<string, string>;
} {
  const files: Record<string, string> = {
    "month.json": ledgerToJson(demoLedger()),
    "bank.csv": EXTRA_CSV,
    ...seed,
  };
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

const post = (environment: CliEnvironment, ...extra: string[]) =>
  run(["post", "-l", "month.json", "-s", "bank.csv", "-a", "1110", ...extra], environment);

interface PostJson {
  readonly account: string;
  readonly proposals: readonly {
    readonly description: string;
    readonly outcome: string;
    readonly rule: string | null;
    readonly account: string | null;
    readonly entry: string | null;
  }[];
  readonly summary: {
    readonly total: number;
    readonly booked: number;
    readonly unclassified: number;
    readonly alreadyBooked: number;
    readonly net: string;
    readonly byAccount: readonly { account: string; amount: string; count: number }[];
  };
  readonly wrote?: string;
}

const asJson = (text: string): PostJson => JSON.parse(text) as PostJson;

describe("tallyd post", () => {
  it("classifies the lines the books never heard of", () => {
    const { environment } = harness();
    const parsed = asJson(post(environment, "--json").stdout);

    // The demo month leaves its own charges, interest and PAYE unmatched too,
    // so what matters is which accounts the classifier reached for.
    const booked = parsed.proposals.filter((proposal) => proposal.outcome === "book");
    expect(new Set(booked.map((proposal) => proposal.account))).toEqual(
      new Set(["2300", "4300", "5300", "5800"]),
    );
  });

  it("leaves the line nothing explains unclassified", () => {
    const { environment } = harness();
    const parsed = asJson(post(environment, "--json").stdout);

    const mystery = parsed.proposals.find((proposal) => proposal.description.includes("NOBODY KNOWS"));
    expect(mystery?.outcome).toBe("unclassified");
    expect(mystery?.entry).toBeNull();
  });

  it("writes nothing unless asked", () => {
    const { environment, files } = harness();
    const before = { ...files };
    post(environment);
    expect(files).toEqual(before);
  });

  it("says so when it has proposals and no --out", () => {
    const { environment } = harness();
    expect(post(environment).stdout).toContain("Pass --out to apply these");
  });

  it("applies them to a ledger that still balances", () => {
    const { environment, files } = harness();
    const result = post(environment, "-o", "booked.json");

    expect(result.code).toBe(0);
    const after = ledgerFromJson(files["booked.json"] as string);
    expect(trialBalance(after).balanced).toBe(true);
    expect(() => after.verify()).not.toThrow();
  });

  it("moves the bank balance by the net of what it booked", () => {
    const { environment, files } = harness();
    const parsed = asJson(post(environment, "--json", "-o", "booked.json").stdout);

    const before = demoLedger().balanceOf("1110");
    const after = ledgerFromJson(files["booked.json"] as string).balanceOf("1110");
    expect(after.minus(before).toDecimalString()).toBe(parsed.summary.net);
  });

  it("puts the bank charge in 5800 and the interest in 4300", () => {
    const { environment, files } = harness();
    post(environment, "-o", "booked.json");
    const after = ledgerFromJson(files["booked.json"] as string);

    const before = demoLedger();
    // Deltas, because the demo month already books a bank charge of its own.
    expect(after.balanceOf("5800").minus(before.balanceOf("5800")).toDecimalString()).toBe("6.50");
    expect(after.balanceOf("4300").minus(before.balanceOf("4300")).toDecimalString()).toBe("-6.22");
  });

  it("running it twice changes nothing the second time", () => {
    const { environment, files } = harness();
    post(environment, "-o", "booked.json");

    const second = run(
      ["post", "-l", "booked.json", "-s", "bank.csv", "-a", "1110", "-o", "again.json", "--json"],
      environment,
    );
    const parsed = asJson(second.stdout);

    expect(parsed.summary.booked).toBe(0);
    expect(files["again.json"]).toBe(files["booked.json"]);
  });

  it("books the remainder only into an account that already exists", () => {
    const { environment } = harness();
    const parsed = asJson(post(environment, "--suspense", "1120", "--json").stdout);

    expect(parsed.summary.unclassified).toBe(0);
    const mystery = parsed.proposals.find((proposal) => proposal.description.includes("NOBODY KNOWS"));
    expect(mystery?.account).toBe("1120");
  });

  it("warns that unmatched is not the same as unbooked when a suspense account is used", () => {
    const { environment } = harness();
    expect(post(environment, "--suspense", "1120").stdout).toContain("failed to");
  });

  it("refuses a suspense account the chart cannot post to", () => {
    const { environment } = harness();
    const result = post(environment, "--suspense", "1100");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not one this chart can post to");
  });

  it("exits 2 under --strict when something could not be classified", () => {
    const { environment } = harness();
    const result = post(environment, "--strict");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("could not be classified");
  });

  it("exits 0 under --strict once everything has an account", () => {
    const { environment } = harness();
    expect(post(environment, "--strict", "--suspense", "1120").code).toBe(0);
  });

  it("takes rules from a file when one is given", () => {
    const { environment } = harness({
      "rules.json": JSON.stringify([
        { id: "mystery", describe: "whoever this is", match: { any: ["NOBODY KNOWS"] }, account: "5700" },
      ]),
    });
    const parsed = asJson(post(environment, "-r", "rules.json", "--json").stdout);

    const mystery = parsed.proposals.find((proposal) => proposal.description.includes("NOBODY KNOWS"));
    expect(mystery?.account).toBe("5700");
    // The built-in rules are replaced, not extended: the bank charge no longer
    // has anywhere to go.
    expect(parsed.summary.unclassified).toBeGreaterThan(0);
  });

  it("rejects a rules file it cannot use", () => {
    const { environment } = harness({ "rules.json": '[{"id":"x","match":{"any":["Y"]}}]' });
    const result = post(environment, "-r", "rules.json");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("names no account");
  });

  it("says so in a read-only environment before writing anything", () => {
    const { environment } = harness();
    const readOnly: CliEnvironment = { readFile: environment.readFile, today: environment.today };
    const result = run(
      ["post", "-l", "month.json", "-s", "bank.csv", "-a", "1110", "-o", "booked.json"],
      readOnly,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("cannot write files");
  });

  it("refuses a grouping account like every other command", () => {
    const { environment } = harness();
    const result = run(["post", "-l", "month.json", "-s", "bank.csv", "-a", "1100"], environment);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("cannot be posted to");
  });

  it("appears in the top-level help", () => {
    expect(run(["--help"], harness().environment).stdout).toContain("post");
  });

  it("has help of its own", () => {
    const help = run(["post", "--help"], harness().environment).stdout;
    expect(help).toContain("--suspense");
    expect(help).toContain("--strict");
  });
});

describe("decisions reaching post through the memory", () => {
  /**
   * A rejection means the reviewer says this statement line does *not* belong
   * to that ledger entry. The pair should stop being a suggestion, which puts
   * the statement line in front of `post` as something that may need booking.
   */
  it("a rejected pairing turns a suggestion into a line post can see", () => {
    const { environment } = harness();

    const queue = JSON.parse(
      run(["reconcile", "-l", "month.json", "-s", "bank.csv", "-a", "1110", "--json"], environment)
        .stdout,
    ) as { suggested: { book: string[]; statement: string[] }[] };
    expect(queue.suggested.length).toBeGreaterThan(0);

    const before = asJson(post(environment, "--json").stdout).summary;

    // The descriptions behind the first suggestion, as the reviewer saw them.
    const imported = importCsv(EXTRA_CSV, { currency: GBP, idPrefix: "BANK" });
    const books = bankView(demoLedger(), "1110");
    const first = reconcile(books, imported.lines).suggested[0];
    expect(first).toBeDefined();

    environment.readFile("month.json");
    const decisions = (first as NonNullable<typeof first>).statement.flatMap((statement) =>
      (first as NonNullable<typeof first>).book.map((book) => ({
        statement: statement.description,
        book: book.description,
        accepted: false,
        on: "2026-09-30",
      })),
    );
    const withFile = harness({ "decisions.json": JSON.stringify(decisions) });
    const after = asJson(post(withFile.environment, "-d", "decisions.json", "--json").stdout).summary;

    expect(after.total).toBeGreaterThan(before.total);
  });

  it("reads the decisions file the dashboard writes", () => {
    const { environment } = harness({
      "decisions.json": JSON.stringify([
        {
          statement: "ACCOUNT MAINTENANCE FEE",
          book: "Bank charges",
          accepted: true,
          on: "2026-09-30",
          context: { amount: "-6.50", kind: "one-to-one", confidence: "medium" },
        },
      ]),
    });
    expect(post(environment, "-d", "decisions.json").code).toBe(0);
  });

  it("rejects a decisions file it cannot read", () => {
    const { environment } = harness({ "decisions.json": "{not json" });
    const result = post(environment, "-d", "decisions.json");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not valid JSON");
  });
});
