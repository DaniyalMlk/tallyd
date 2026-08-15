/**
 * A sales ledger with a genuine ageing problem.
 *
 * The worked month has one invoice and it was paid, which proves nothing about
 * an ageing report. This is a quarter of trading for the same consultancy:
 * seven invoices raised between June and September, three settled in full, one
 * part paid, one overpaid, and two still outstanding at the far end of the
 * ageing profile — which is the shape a real sales ledger has and the shape a
 * report has to survive.
 */

import { Money } from "../money/money.js";
import { GBP } from "../money/currency.js";
import { standardChart } from "../accounts/standard.js";
import { JournalEntry } from "../ledger/entry.js";
import { Ledger } from "../ledger/ledger.js";

const gbp = (text: string) => Money.parse(text, GBP);

interface Invoice {
  readonly reference: string;
  readonly customer: string;
  readonly raised: string;
  readonly net: string;
  readonly vat: string;
}

/** VAT is charged at 20%, so the receivable is always net plus VAT. */
export const RECEIVABLE_INVOICES: readonly Invoice[] = Object.freeze([
  Object.freeze({ reference: "INV-2001", customer: "Northwind Ltd", raised: "2026-06-12", net: "4000.00", vat: "800.00" }),
  Object.freeze({ reference: "INV-2002", customer: "Kestrel Group", raised: "2026-06-30", net: "1500.00", vat: "300.00" }),
  Object.freeze({ reference: "INV-2003", customer: "Halden plc", raised: "2026-07-14", net: "2750.00", vat: "550.00" }),
  Object.freeze({ reference: "INV-2004", customer: "Mirrell Legal", raised: "2026-08-03", net: "900.00", vat: "180.00" }),
  Object.freeze({ reference: "INV-2005", customer: "Northwind Ltd", raised: "2026-08-21", net: "3200.00", vat: "640.00" }),
  Object.freeze({ reference: "INV-2006", customer: "Corbin Facilities", raised: "2026-09-09", net: "1250.00", vat: "250.00" }),
  Object.freeze({ reference: "INV-2007", customer: "Kestrel Group", raised: "2026-09-25", net: "600.00", vat: "120.00" }),
]);

interface Receipt {
  readonly id: string;
  readonly reference: string;
  readonly date: string;
  readonly amount: string;
}

export const RECEIVABLE_RECEIPTS: readonly Receipt[] = Object.freeze([
  // Paid in full.
  Object.freeze({ id: "RCT-01", reference: "INV-2002", date: "2026-07-28", amount: "1800.00" }),
  Object.freeze({ id: "RCT-02", reference: "INV-2004", date: "2026-08-29", amount: "1080.00" }),
  Object.freeze({ id: "RCT-03", reference: "INV-2006", date: "2026-09-20", amount: "1500.00" }),
  // Part payment: £2,000 against £4,800, leaving £2,800 outstanding since June.
  Object.freeze({ id: "RCT-04", reference: "INV-2001", date: "2026-08-15", amount: "2000.00" }),
  // Overpaid by £100 — a credit sits on the customer's account.
  Object.freeze({ id: "RCT-05", reference: "INV-2003", date: "2026-09-02", amount: "3400.00" }),
]);

/** Quarter to 30 September, from the sales side. */
export function receivablesLedger(): Ledger {
  const chart = standardChart(GBP);
  let ledger = Ledger.empty(chart);

  ledger = ledger.post(
    JournalEntry.simple({
      id: "OPEN",
      date: "2026-06-01",
      narration: "Opening balance brought forward",
      debit: "1110",
      credit: "3200",
      amount: gbp("12000.00"),
    }),
  );

  for (const invoice of RECEIVABLE_INVOICES) {
    const net = gbp(invoice.net);
    const vat = gbp(invoice.vat);
    ledger = ledger.post(
      JournalEntry.create({
        id: invoice.reference,
        date: invoice.raised,
        narration: `${invoice.customer} — ${invoice.reference}`,
        reference: invoice.reference,
        tags: ["sales"],
        postings: [
          { account: "1130", amount: net.plus(vat), memo: invoice.customer },
          { account: "4200", amount: net.negated() },
          { account: "2200", amount: vat.negated(), memo: "VAT at 20%" },
        ],
      }),
    );
  }

  for (const receipt of RECEIVABLE_RECEIPTS) {
    ledger = ledger.post(
      JournalEntry.simple({
        id: receipt.id,
        date: receipt.date,
        narration: `Receipt against ${receipt.reference}`,
        debit: "1110",
        credit: "1130",
        amount: gbp(receipt.amount),
        reference: receipt.reference,
      }),
    );
  }

  // A few costs, so the income statement has both sides to work with.
  const costs: [string, string, string, string][] = [
    ["EXP-01", "2026-06-04", "5300", "1850.00"],
    ["EXP-02", "2026-07-04", "5300", "1850.00"],
    ["EXP-03", "2026-08-04", "5300", "1850.00"],
    ["EXP-04", "2026-09-04", "5300", "1850.00"],
    ["EXP-05", "2026-07-15", "5400", "299.00"],
    ["EXP-06", "2026-08-19", "5600", "412.65"],
    ["EXP-07", "2026-09-18", "5700", "1250.00"],
  ];
  for (const [id, date, account, amount] of costs) {
    ledger = ledger.post(
      JournalEntry.simple({
        id,
        date,
        narration: `${chart.get(account).name} — ${date.slice(0, 7)}`,
        debit: account,
        credit: "1110",
        amount: gbp(amount),
      }),
    );
  }

  return ledger;
}

/** What should still be outstanding on 2026-09-30, worked out by hand. */
export const EXPECTED_OPEN_ITEMS: readonly { reference: string; outstanding: string; days: number }[] =
  Object.freeze([
    Object.freeze({ reference: "INV-2001", outstanding: "2800.00", days: 110 }),
    Object.freeze({ reference: "INV-2003", outstanding: "-100.00", days: 78 }),
    Object.freeze({ reference: "INV-2005", outstanding: "3840.00", days: 40 }),
    Object.freeze({ reference: "INV-2007", outstanding: "720.00", days: 5 }),
  ]);
