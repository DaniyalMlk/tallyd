/**
 * The dashboard the site publishes, built from generated books.
 *
 * Pure, and separate from `build-site.ts`, for the same reason the page
 * generator is: the tests have to be able to assert what the published
 * dashboard contains without writing a file anywhere.
 *
 * The books are the generator's rather than the small hand-written demo
 * ledgers, because the dashboard's whole point is a queue worth working
 * through and a hand-written month has nine movements in it. A year at a dozen
 * invoices a month gives a page with a few hundred lines on it, which is what
 * someone looking at a reconciliation tool wants to see, and it is the same
 * sample the evidence gate scores — so the queue a visitor works through is
 * the queue the front page's recall figures were measured on.
 *
 * The seed is fixed. A dashboard that changed every time the site was
 * published would make the page impossible to write about and the test
 * impossible to pin.
 */

import { dashboardData } from "../src/dashboard/model.js";
import { renderDashboard } from "../src/dashboard/render.js";
import { generateBooks } from "../src/demo/generator.js";
import { bankView } from "../src/reconcile/bankView.js";
import { statementClosingBalance } from "../src/reconcile/bridge.js";
import { reconcile } from "../src/reconcile/matcher.js";
import { proposeEntries } from "../src/reconcile/posting.js";
import { Money } from "../src/money/index.js";

/** The sample the published dashboard is built from. */
export const SAMPLE = Object.freeze({
  seed: 11,
  months: 12,
  invoicesPerMonth: 12,
  start: "2026-01-01",
} as const);

export interface ReviewDashboard {
  readonly html: string;
  readonly matched: number;
  readonly toReview: number;
  readonly unexplained: number;
  readonly bookLines: number;
  readonly statementLines: number;
}

export function reviewDashboard(): ReviewDashboard {
  const generated = generateBooks({ ...SAMPLE });
  const books = bankView(generated.ledger, generated.bankAccount);
  const result = reconcile(books, generated.statement);

  // Every statement line gets a proposal, not only the ones currently
  // unmatched, for the same reason the CLI does it: the page decides which are
  // live from its own leftovers, so a rejection has to have something to show
  // the moment it is made.
  const implied = proposeEntries(generated.statement, {
    account: generated.bankAccount,
    ledger: generated.ledger,
  });

  const zero = Money.zero(generated.currency);
  const html = renderDashboard(
    dashboardData({
      ledger: generated.ledger,
      account: generated.bankAccount,
      books,
      statement: generated.statement,
      result,
      bankClosingBalance: statementClosingBalance(generated.statement, zero),
      bookClosingBalance: books.reduce((total, line) => total.plus(line.amount), zero),
      statementFormat: "csv",
      implied,
    }),
  );

  return {
    html,
    matched: result.matched.length,
    toReview: result.suggested.length,
    unexplained: result.unmatchedStatement.length,
    bookLines: books.length,
    statementLines: generated.statement.length,
  };
}
