/**
 * A quarter with two foreign-currency customers, and what the close does about
 * them.
 *
 * The story is deliberately small enough to check by hand:
 *
 * - 20 January, an invoice to a Dutch client for 1,000 EUR. The euro buys
 *   0.8400, so the books carry a receivable of 840.00.
 * - 20 January, a bill from an American supplier for 500 USD at 0.7800, so a
 *   payable of 390.00.
 * - 15 February, a second euro invoice, 500 EUR at 0.8500, so 425.00.
 * - 31 March, the close. The euro is at 0.8600 and the dollar at 0.7700.
 *   Nothing has been paid, so the whole movement is unrealised.
 * - 20 April, the Dutch client pays the February invoice; the euro is at
 *   0.8700. That much of the movement is now realised.
 * - 20 April, the American supplier is paid; the dollar is at 0.7600.
 *
 * The point of running it is the arithmetic at the end: unrealised plus
 * realised equals what the rate actually did, counted once.
 */

import { ChartOfAccounts } from "../accounts/chart.js";
import { STANDARD_ACCOUNTS } from "../accounts/standard.js";
import { JournalEntry } from "../ledger/entry.js";
import { Ledger } from "../ledger/ledger.js";
import { EUR, GBP, USD } from "../money/currency.js";
import { Money } from "../money/money.js";
import { RateTable } from "../fx/table.js";

/** The standard chart, plus a receivable in euros and a payable in dollars. */
export function foreignChart(): ChartOfAccounts {
  return ChartOfAccounts.build(
    [
      ...STANDARD_ACCOUNTS,
      {
        code: "1131",
        name: "Accounts Receivable (EUR)",
        type: "asset",
        parent: "1100",
        currency: "EUR",
        description: "What euro customers owe, in euros",
      },
      {
        code: "2101",
        name: "Accounts Payable (USD)",
        type: "liability",
        parent: "2000",
        currency: "USD",
        description: "What is owed to dollar suppliers, in dollars",
      },
    ],
    { currency: "GBP" },
  );
}

/** Rates for the quarter, quoted against sterling on the days that matter. */
export function foreignRates(): RateTable {
  return RateTable.of(
    [
      { date: "2026-01-20", base: "EUR", quote: "GBP", rate: "0.8400", source: "demo" },
      { date: "2026-01-20", base: "USD", quote: "GBP", rate: "0.7800", source: "demo" },
      { date: "2026-02-15", base: "EUR", quote: "GBP", rate: "0.8500", source: "demo" },
      { date: "2026-02-15", base: "USD", quote: "GBP", rate: "0.7750", source: "demo" },
      { date: "2026-03-31", base: "EUR", quote: "GBP", rate: "0.8600", source: "demo" },
      { date: "2026-03-31", base: "USD", quote: "GBP", rate: "0.7700", source: "demo" },
      { date: "2026-04-20", base: "EUR", quote: "GBP", rate: "0.8700", source: "demo" },
      { date: "2026-04-20", base: "USD", quote: "GBP", rate: "0.7600", source: "demo" },
    ],
    { maxStaleDays: 30 },
  );
}

/** The quarter as booked: three transactions, none of them settled. */
export function foreignLedger(): Ledger {
  const chart = foreignChart();
  return Ledger.from(
    [
      JournalEntry.create({
        id: "INV-2026-014",
        date: "2026-01-20",
        narration: "Invoice — Blauwe Zee BV",
        reference: "INV-014",
        postings: [
          {
            account: "1131",
            amount: Money.parse("840.00", GBP),
            foreign: Money.parse("1000.00", EUR),
            memo: "1,000.00 EUR at 0.8400",
          },
          { account: "4200", amount: Money.parse("-840.00", GBP) },
        ],
      }),
      JournalEntry.create({
        id: "BILL-2026-221",
        date: "2026-01-20",
        narration: "Bill — Redwood Systems Inc",
        reference: "BILL-221",
        postings: [
          { account: "5400", amount: Money.parse("390.00", GBP) },
          {
            account: "2101",
            amount: Money.parse("-390.00", GBP),
            foreign: Money.parse("-500.00", USD),
            memo: "500.00 USD at 0.7800",
          },
        ],
      }),
      JournalEntry.create({
        id: "INV-2026-021",
        date: "2026-02-15",
        narration: "Invoice — Blauwe Zee BV",
        reference: "INV-021",
        postings: [
          {
            account: "1131",
            amount: Money.parse("425.00", GBP),
            foreign: Money.parse("500.00", EUR),
            memo: "500.00 EUR at 0.8500",
          },
          { account: "4200", amount: Money.parse("-425.00", GBP) },
        ],
      }),
    ],
    chart,
  );
}
