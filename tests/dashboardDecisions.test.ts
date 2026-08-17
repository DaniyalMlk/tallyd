import { describe, expect, it } from "vitest";
import { GBP, Money } from "../src/money/index.js";
import { importCsv } from "../src/statement/import.js";
import { bankView } from "../src/reconcile/bankView.js";
import { reconcile } from "../src/reconcile/matcher.js";
import { statementClosingBalance } from "../src/reconcile/bridge.js";
import { dashboardData, type DashboardData, type MatchView } from "../src/dashboard/model.js";
import { renderDashboard } from "../src/dashboard/render.js";
import { CLIENT_SCRIPT } from "../src/dashboard/script.js";
import {
  decisionRecord,
  decisionsFor,
  parseDecisions,
  serialiseDecisions,
  type DecisionRecord,
} from "../src/reconcile/decisions.js";
import { MatchMemory } from "../src/reconcile/memory.js";
import { proposeEntries } from "../src/reconcile/posting.js";
import { demoLedger } from "../src/demo/month.js";
import { DEMO_BANK_CSV } from "../src/demo/statement.js";
import { supplierRunLedger, SUPPLIER_RUN_CSV } from "../src/demo/supplierRun.js";

function build(ledgerBuilder: () => ReturnType<typeof demoLedger>, csv: string): DashboardData {
  const ledger = ledgerBuilder();
  const imported = importCsv(csv, { currency: GBP, idPrefix: "BANK" });
  const statement = [...imported.lines, ...imported.duplicates.map((flag) => flag.line)].sort(
    (a, b) => a.sourceRow - b.sourceRow,
  );
  const books = bankView(ledger, "1110");
  const result = reconcile(books, statement);
  return dashboardData({
    ledger,
    account: "1110",
    books,
    statement,
    result,
    bankClosingBalance: statementClosingBalance(statement, Money.zero(GBP)),
    bookClosingBalance: books.reduce((total, line) => total.plus(line.amount), Money.zero(GBP)),
    statementFormat: "csv",
    implied: proposeEntries(statement, { account: "1110", ledger }),
  });
}

const month = build(demoLedger, DEMO_BANK_CSV);
const supplier = build(supplierRunLedger, SUPPLIER_RUN_CSV);

const everyMatch = (data: DashboardData): readonly MatchView[] => [...data.matched, ...data.suggested];

/** What the browser does with a decided suggestion, in one line. */
function decide(match: MatchView, accepted: boolean, on = "2026-04-30"): readonly DecisionRecord[] {
  return match.decision.map((payload) => decisionRecord(payload, accepted, on));
}

describe("the payload baked into the page", () => {
  it("gives every match something to emit", () => {
    for (const match of everyMatch(month)) {
      expect(match.decision.length).toBeGreaterThan(0);
    }
  });

  it("emits one fact for a 1:1 match", () => {
    const pairs = everyMatch(month).filter((match) => match.kind === "one-to-one");
    expect(pairs.length).toBeGreaterThan(0);
    for (const match of pairs) expect(match.decision).toHaveLength(1);
  });

  it("pairs the descriptions the reviewer was actually shown", () => {
    for (const match of everyMatch(month)) {
      const statements = new Set(match.statement.map((line) => line.description));
      const books = new Set(match.book.map((line) => line.description));
      for (const payload of match.decision) {
        expect(statements.has(payload.statement)).toBe(true);
        expect(books.has(payload.book)).toBe(true);
      }
    }
  });

  it("a batch payment teaches one fact per distinct supplier", () => {
    const group = everyMatch(supplier).find((match) => match.book.length > 1);
    expect(group).toBeDefined();
    const distinct = new Set((group as MatchView).book.map((line) => line.description)).size;
    expect((group as MatchView).decision).toHaveLength(distinct);
  });

  it("never repeats the same pairing within one suggestion", () => {
    for (const match of [...everyMatch(month), ...everyMatch(supplier)]) {
      const keys = match.decision.map((payload) => `${payload.statement}|${payload.book}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("carries the amount, date, kind and confidence as context", () => {
    for (const match of everyMatch(month)) {
      for (const payload of match.decision) {
        expect(payload.context.amount).toBe(match.amount.text);
        expect(payload.context.kind).toBe(match.kind);
        expect(payload.context.confidence).toBe(match.confidence);
        expect(payload.context.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it("survives the JSON round trip into the page", () => {
    const restored = JSON.parse(JSON.stringify(month)) as DashboardData;
    expect(restored.suggested.map((match) => match.decision)).toEqual(
      month.suggested.map((match) => match.decision),
    );
  });
});

describe("what the page writes is what the CLI reads", () => {
  it("a queue worked through end to end parses as a decisions document", () => {
    const records = month.suggested.flatMap((match, index) => decide(match, index % 2 === 0));
    expect(records.length).toBeGreaterThan(0);

    const parsed = parseDecisions(serialiseDecisions(records));
    expect(parsed).toEqual(records);
  });

  it("the memory learns from it without anything in between", () => {
    const first = month.suggested[0];
    expect(first).toBeDefined();

    const text = serialiseDecisions(decide(first as MatchView, true));
    const memory = MatchMemory.from(decisionsFor(text));

    const payload = (first as MatchView).decision[0];
    expect(payload).toBeDefined();
    expect(memory.recall(payload!.statement, payload!.book).kind).toBe("confirmed");
  });

  it("a rejection reaches the memory as a rejection", () => {
    const first = month.suggested[0] as MatchView;
    const memory = MatchMemory.from(decisionsFor(serialiseDecisions(decide(first, false))));
    const payload = first.decision[0]!;

    expect(memory.recall(payload.statement, payload.book).kind).toBe("rejected");
  });

  it("accepting a batch teaches every supplier in it", () => {
    const group = everyMatch(supplier).find((match) => match.book.length > 1) as MatchView;
    const memory = MatchMemory.from(decisionsFor(serialiseDecisions(decide(group, true))));

    for (const payload of group.decision) {
      expect(memory.recall(payload.statement, payload.book).kind).toBe("confirmed");
    }
  });

  it("a decision file from one run means the same thing in the next", () => {
    const group = everyMatch(supplier).find((match) => match.book.length > 1) as MatchView;
    const text = serialiseDecisions(decide(group, true));

    const once = MatchMemory.from(decisionsFor(text));
    const twice = MatchMemory.from(decisionsFor(serialiseDecisions(parseDecisions(text))));

    expect(twice.toDocument()).toEqual(once.toDocument());
  });
});

describe("the page itself", () => {
  const html = renderDashboard(month);

  it("carries the decision bar and its three controls", () => {
    expect(html).toContain('id="decision-bar"');
    for (const action of ["export-decisions", "copy-decisions", "undo-last"]) {
      expect(html).toContain(`data-action="${action}"`);
    }
  });

  it("hides the decided section until there is something in it", () => {
    expect(html).toContain('<section id="decided-section" hidden>');
    expect(html).toContain('data-open="false"');
  });

  it("embeds the payloads rather than leaving the browser to invent them", () => {
    const payload = month.suggested[0]?.decision[0];
    expect(payload).toBeDefined();
    expect(html).toContain(JSON.stringify(payload!.statement).slice(1, -1));
  });

  it("the client script only ever stamps the verdict and the date", () => {
    // The four structural fields come from the embedded payload; if the script
    // started building `statement:` or `book:` itself, the format would have
    // two definitions again.
    expect(CLIENT_SCRIPT).toContain("payloads[j].statement");
    expect(CLIENT_SCRIPT).toContain("payloads[j].book");
    expect(CLIENT_SCRIPT).toContain('accepted: entry.verdict === "accepted"');
  });

  it("stays one file with no network", () => {
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/https?:\/\//);
  });
});


describe("what the reconciliation implies", () => {
  it("carries a proposal for every statement line, not only the unmatched ones", () => {
    const lineIds = new Set([
      ...month.unmatchedStatement.map((line) => line.id),
      ...month.matched.flatMap((match) => match.statement.map((line) => line.id)),
      ...month.suggested.flatMap((match) => match.statement.map((line) => line.id)),
    ]);

    expect(month.implied.length).toBe(lineIds.size);
    for (const proposal of month.implied) expect(lineIds.has(proposal.lineId)).toBe(true);
  });

  /**
   * The reason for precomputing all of them: rejecting a suggestion has to
   * produce a row immediately, and the browser cannot classify anything.
   */
  it("has something to show for a line currently sitting in the queue", () => {
    const queued = month.suggested.flatMap((match) => match.statement.map((line) => line.id));
    expect(queued.length).toBeGreaterThan(0);
    for (const id of queued) {
      expect(month.implied.some((proposal) => proposal.lineId === id)).toBe(true);
    }
  });

  it("names the account and its name, so the page never has to look one up", () => {
    const charge = month.implied.find((proposal) => proposal.description.includes("BANK CHARGES"));
    expect(charge?.outcome).toBe("book");
    expect(charge?.account).toBe("5800");
    expect(charge?.accountName).toBe("Bank Charges");
  });

  it("classifies the interest the demo month never booked", () => {
    const interest = month.implied.find((proposal) => proposal.description.includes("INTEREST"));
    expect(interest?.account).toBe("4300");
  });

  it("says which rule fired, and why", () => {
    const charge = month.implied.find((proposal) => proposal.description.includes("BANK CHARGES"));
    expect(charge?.rule).toBe("bank-charges");
    expect(charge?.reason).toContain("5800");
  });

  it("leaves an unclassifiable line with no account", () => {
    const cash = month.implied.find((proposal) => proposal.description.includes("ATM CASH"));
    expect(cash?.outcome).toBe("unclassified");
    expect(cash?.account).toBeNull();
  });

  it("survives the JSON round trip into the page", () => {
    const restored = JSON.parse(JSON.stringify(month)) as DashboardData;
    expect(restored.implied).toEqual(month.implied);
  });

  it("is empty, not absent, when no proposals were supplied", () => {
    const ledger = demoLedger();
    const imported = importCsv(DEMO_BANK_CSV, { currency: GBP, idPrefix: "BANK" });
    const books = bankView(ledger, "1110");
    const bare = dashboardData({
      ledger,
      account: "1110",
      books,
      statement: imported.lines,
      result: reconcile(books, imported.lines),
      bankClosingBalance: statementClosingBalance(imported.lines, Money.zero(GBP)),
      bookClosingBalance: books.reduce((total, line) => total.plus(line.amount), Money.zero(GBP)),
      statementFormat: "csv",
    });
    expect(bare.implied).toEqual([]);
  });

  it("gets a section on the page that the script fills in", () => {
    const html = renderDashboard(month);
    expect(html).toContain('id="implied-section"');
    expect(html).toContain('id="implied"');
    expect(CLIENT_SCRIPT).toContain("renderImplied");
  });

  it("decides what is live from the leftovers, which is state the page keeps", () => {
    expect(CLIENT_SCRIPT).toContain("impliedByLine[state.unmatchedStatement[i].id]");
  });
});
