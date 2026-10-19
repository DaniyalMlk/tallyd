/**
 * Declaring intragroup stock in a group document, and consolidating it.
 *
 * The module that prices the provision is tested on its own; this is the other
 * half, which is that somebody can state the facts in a file and get the
 * adjustment out of the command line. The thing worth testing here is the
 * basis: "25%" is a fifth of the selling price under one convention and a
 * quarter of it under the other, so a document format that let the convention
 * be left out would be wrong by a quarter of the provision while looking
 * complete. It is required, it is validated against the three names, and a
 * document that says something else is rejected by name rather than
 * interpreted.
 */

import { describe, expect, it } from "vitest";
import { ChartOfAccounts } from "../src/accounts/chart.js";
import { STANDARD_ACCOUNTS } from "../src/accounts/standard.js";
import { CONSOLIDATION_ACCOUNTS } from "../src/group/accounts.js";
import { JournalEntry } from "../src/ledger/entry.js";
import { Ledger } from "../src/ledger/ledger.js";
import { date } from "../src/ledger/index.js";
import { ledgerToJson } from "../src/ledger/serialise.js";
import { GBP } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { RateTable } from "../src/fx/table.js";
import { ratesToJson } from "../src/fx/document.js";
import { GroupDocumentError, groupFromJson } from "../src/group/document.js";
import { run, type CliEnvironment } from "../src/cli/run.js";

const STOCK = "1160";

const CHART = ChartOfAccounts.build(
  [
    ...STANDARD_ACCOUNTS,
    ...CONSOLIDATION_ACCOUNTS,
    { code: STOCK, name: "Inventory", type: "asset", parent: "1100" },
  ],
  { currency: "GBP" },
);

const gbp = (text: string): Money => Money.parse(text, GBP);

interface Leg {
  id: string;
  date: string;
  narration: string;
  debit: string;
  credit: string;
  amount: string;
}

function ledgerOf(legs: readonly Leg[]): Ledger {
  return Ledger.from(
    legs.map((leg) =>
      JournalEntry.simple(
        { ...leg, amount: gbp(leg.amount) },
        CHART,
      ),
    ),
    CHART,
  );
}

/**
 * P owns three quarters of S, bought for 90,000 when S's net assets were
 * 100,000. S sold P 100,000 of goods at cost plus a quarter and P still has
 * all of them, so 20,000 of the margin has not been earned by the group.
 */
function books(): { P: Ledger; S: Ledger } {
  return {
    P: ledgerOf([
      { id: "P-CAP", date: "2026-01-01", narration: "Capital", debit: "1110", credit: "3100", amount: "400000.00" },
      { id: "P-INV", date: "2026-01-01", narration: "Investment in S", debit: "1230", credit: "1110", amount: "90000.00" },
      { id: "P-RECV", date: "2026-06-30", narration: "Goods from S", debit: STOCK, credit: "2190", amount: "100000.00" },
    ]),
    S: ledgerOf([
      { id: "S-CAP", date: "2026-01-01", narration: "Capital", debit: "1110", credit: "3100", amount: "100000.00" },
      { id: "S-BUY", date: "2026-06-01", narration: "Goods in", debit: STOCK, credit: "1110", amount: "80000.00" },
      { id: "S-SELL", date: "2026-06-30", narration: "Goods to P", debit: "1190", credit: "4950", amount: "100000.00" },
      { id: "S-COS", date: "2026-06-30", narration: "Cost of those goods", debit: "5100", credit: STOCK, amount: "80000.00" },
    ]),
  };
}

// Both companies keep sterling books, so nothing here needs translating. The
// rates file still has to exist and parse, and a GBP/GBP rate is rightly
// refused as meaningless, so it carries a pair that nothing uses.
const RATES = RateTable.of([{ date: "2026-12-31", base: "EUR", quote: "GBP", rate: "0.8000" }], {
  maxStaleDays: 400,
});

const CONSIGNMENT = {
  seller: "S",
  holder: "P",
  account: STOCK,
  onHand: { amount: "100000.00", currency: "GBP" },
  basis: "markup-on-cost",
  rate: "25%",
  note: "the June consignment, unsold",
};

function documentWith(stock: readonly unknown[] | undefined): Record<string, unknown> {
  return {
    version: 1,
    name: "The Harrowgate Group",
    presentation: "GBP",
    asAt: "2026-12-31",
    period: { from: "2026-01-01", to: "2026-12-31" },
    entities: [
      { code: "P", name: "Parent Ltd", currency: "GBP", ledger: "p.json" },
      {
        code: "S",
        name: "Sub Ltd",
        currency: "GBP",
        parent: "P",
        holding: "75",
        acquired: "2026-01-01",
        ledger: "s.json",
      },
    ],
    intercompany: [
      { entity: "S", account: "1190", counterparty: "P", link: "trading" },
      { entity: "P", account: "2190", counterparty: "S", link: "trading" },
    ],
    acquisitions: [{ entity: "S", consideration: { amount: "90000.00", currency: "GBP" } }],
    ...(stock === undefined ? {} : { intragroupStock: stock }),
  };
}

function harness(document: unknown): CliEnvironment {
  const { P, S } = books();
  const files: Record<string, string> = {
    "group.json": JSON.stringify(document, null, 2),
    "p.json": ledgerToJson(P),
    "s.json": ledgerToJson(S),
    "rates.json": ratesToJson(RATES),
  };
  return {
    readFile: (path: string) => {
      const contents = files[path];
      if (contents === undefined) throw new Error(`ENOENT: open '${path}'`);
      return contents;
    },
    writeFile: () => {
      /* nothing in these cases writes */
    },
    today: () => date("2026-12-31"),
  };
}

const ARGS = ["consolidate", "-g", "group.json", "-r", "rates.json", "--stale", "400"];

describe("a group document that declares intragroup stock", () => {
  it("reads the consignment, the rate and the basis", () => {
    const parsed = groupFromJson(JSON.stringify(documentWith([CONSIGNMENT])));
    expect(parsed.intragroupStock).toHaveLength(1);
    const declaration = parsed.intragroupStock[0];
    expect(declaration?.seller).toBe("S");
    expect(declaration?.holder).toBe("P");
    expect(declaration?.basis).toBe("markup-on-cost");
    // 25% written as a rate, held as the exact rational it is.
    expect(declaration?.rate?.toRatioString()).toBe("1/4");
    expect(declaration?.onHand.equals(gbp("100000.00"))).toBe(true);
    expect(declaration?.note).toBe("the June consignment, unsold");
  });

  it("reads a rate written as a ratio, for the ones that need it", () => {
    const parsed = groupFromJson(
      JSON.stringify(documentWith([{ ...CONSIGNMENT, rate: "1/3" }])),
    );
    expect(parsed.intragroupStock[0]?.rate?.toRatioString()).toBe("1/3");
  });

  it("reads the cost basis, which quotes no rate at all", () => {
    const parsed = groupFromJson(
      JSON.stringify(
        documentWith([
          {
            seller: "S",
            holder: "P",
            account: STOCK,
            onHand: { amount: "100000.00", currency: "GBP" },
            basis: "cost",
            cost: { amount: "80000.00", currency: "GBP" },
          },
        ]),
      ),
    );
    expect(parsed.intragroupStock[0]?.rate).toBeUndefined();
    expect(parsed.intragroupStock[0]?.cost?.equals(gbp("80000.00"))).toBe(true);
  });

  it("is empty, not absent, when nothing is declared", () => {
    expect(groupFromJson(JSON.stringify(documentWith(undefined))).intragroupStock).toHaveLength(0);
  });

  it("refuses a basis it does not know rather than picking one", () => {
    const attempt = (stock: unknown): (() => unknown) => () =>
      groupFromJson(JSON.stringify(documentWith([stock])));
    expect(attempt({ ...CONSIGNMENT, basis: "markup" })).toThrow(GroupDocumentError);
    expect(attempt({ ...CONSIGNMENT, basis: "markup" })).toThrow(
      /must be markup-on-cost, margin-on-price or cost, not "markup"/,
    );
    // And absent is not a default either: there is no safe one to pick.
    const { basis: _dropped, ...noBasis } = CONSIGNMENT;
    expect(attempt(noBasis)).toThrow(/basis must be a non-empty string/);
  });

  it("names the field that is wrong rather than failing generically", () => {
    const attempt = (stock: unknown): (() => unknown) => () =>
      groupFromJson(JSON.stringify(documentWith([stock])));
    const { account: _noAccount, ...withoutAccount } = CONSIGNMENT;
    expect(attempt(withoutAccount)).toThrow(/Intragroup stock declaration 0's account/);
    expect(attempt({ ...CONSIGNMENT, rate: "not a rate" })).toThrow(
      /rate "not a rate" is not a rate/,
    );
    expect(attempt({ ...CONSIGNMENT, onHand: "100000.00" })).toThrow(
      /must be written as \{"amount"/,
    );
    expect(() => groupFromJson(JSON.stringify(documentWith(["nope"] as unknown[])))).toThrow(
      /is not an object/,
    );
  });

  it("refuses a declaration list that is not a list", () => {
    const document = { ...documentWith(undefined), intragroupStock: { seller: "S" } };
    expect(() => groupFromJson(JSON.stringify(document))).toThrow(
      /intragroupStock must be a list of declarations/,
    );
  });
});

describe("tallyd consolidate, with stock the group sold itself", () => {
  it("balances and reports the provision", () => {
    const result = run(ARGS, harness(documentWith([CONSIGNMENT])));
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("DOES NOT BALANCE");
    expect(result.stdout).toContain("Unrealised profit on intragroup stock");
    // A quarter on cost is a fifth of the 100,000 still on hand.
    expect(result.stdout).toContain("Unrealised profit on intragroup stock                  -20000.00");
    // And a quarter of that comes off the stake outside the company that sold.
    expect(result.stdout).toContain("borne by the stakes outside the sellers");
  });

  it("says nothing about it when nothing is declared", () => {
    const result = run(ARGS, harness(documentWith(undefined)));
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("Unrealised profit on intragroup stock");
  });

  it("puts the figures and the attribution in the JSON", () => {
    const result = run([...ARGS, "--json"], harness(documentWith([CONSIGNMENT])));
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      unrealisedProfit: {
        consignments: number;
        provided: string;
        groupShare: string;
        nciShare: string;
        notProvided: readonly unknown[];
      };
    };
    expect(payload.unrealisedProfit.consignments).toBe(1);
    expect(payload.unrealisedProfit.provided).toBe("20000.00");
    expect(payload.unrealisedProfit.groupShare).toBe("15000.00");
    expect(payload.unrealisedProfit.nciShare).toBe("5000.00");
    expect(payload.unrealisedProfit.notProvided).toHaveLength(0);
    // Nothing non-finite reaches a payload.
    expect(JSON.stringify(payload)).not.toContain("null");
  });

  it("reports what it would not provide against instead of writing stock negative", () => {
    const result = run(
      [...ARGS, "--json"],
      harness(documentWith([{ ...CONSIGNMENT, onHand: { amount: "900000.00", currency: "GBP" } }])),
    );
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      unrealisedProfit: { provided: string; notProvided: readonly { reason: string }[] };
      balanced: boolean;
    };
    expect(payload.unrealisedProfit.provided).toBe("0.00");
    expect(payload.unrealisedProfit.notProvided).toHaveLength(1);
    expect(payload.unrealisedProfit.notProvided[0]?.reason).toContain("below nothing");
    expect(payload.balanced).toBe(true);
  });

  it("gives a different answer on the other convention, from the same figures", () => {
    const onPrice = run(
      [...ARGS, "--json"],
      harness(documentWith([{ ...CONSIGNMENT, basis: "margin-on-price" }])),
    );
    const payload = JSON.parse(onPrice.stdout) as { unrealisedProfit: { provided: string } };
    // 25,000 rather than 20,000: which convention the document meant is worth
    // 5,000 on this consignment, and the file has to say.
    expect(payload.unrealisedProfit.provided).toBe("25000.00");
  });
});
