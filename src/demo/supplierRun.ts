/**
 * A second worked example, built for the group-matching case.
 *
 * The consultancy pays four suppliers on the same afternoon. Its accounting
 * software records four separate payments, one per invoice, because that is
 * how the purchase ledger sees the world. The bank records one debit for the
 * total, because that is how BACS works — and then, ten days later, a customer
 * clears three outstanding invoices with a single transfer, which is the same
 * problem in the other direction.
 *
 * Neither event can be reconciled one line at a time, and both are completely
 * ordinary. That is the point of the example.
 */

import { Money } from "../money/money.js";
import { GBP } from "../money/currency.js";
import { standardChart } from "../accounts/standard.js";
import { JournalEntry } from "../ledger/entry.js";
import { Ledger } from "../ledger/ledger.js";

const gbp = (text: string) => Money.parse(text, GBP);

export interface Supplier {
  readonly id: string;
  readonly name: string;
  readonly invoice: string;
  readonly amount: string;
}

/** The four invoices settled in the BACS run of 10 September. */
export const SUPPLIER_RUN: readonly Supplier[] = Object.freeze([
  Object.freeze({ id: "PAY-01", name: "Kestrel Print", invoice: "KP-4417", amount: "412.80" }),
  Object.freeze({ id: "PAY-02", name: "Halden Office Supplies", invoice: "HOS-9002", amount: "168.44" }),
  Object.freeze({ id: "PAY-03", name: "Mirrell Legal", invoice: "ML-233", amount: "1250.00" }),
  Object.freeze({ id: "PAY-04", name: "Corbin Facilities", invoice: "CF-8810", amount: "306.76" }),
]);

/** The three sales invoices the customer clears in one transfer on 20 September. */
export const CUSTOMER_RECEIPTS = Object.freeze([
  Object.freeze({ id: "REC-01", invoice: "INV1042", amount: "2400.00" }),
  Object.freeze({ id: "REC-02", invoice: "INV1043", amount: "1800.00" }),
  Object.freeze({ id: "REC-03", invoice: "INV1044", amount: "960.00" }),
]);

export function supplierRunLedger(): Ledger {
  const chart = standardChart(GBP);
  let ledger = Ledger.empty(chart);

  ledger = ledger.post(
    JournalEntry.simple({
      id: "SEP-000",
      date: "2026-09-01",
      narration: "Opening bank balance brought forward",
      debit: "1110",
      credit: "3200",
      amount: gbp("8000.00"),
    }),
  );

  // Four payments out, one per supplier invoice.
  for (const supplier of SUPPLIER_RUN) {
    ledger = ledger.post(
      JournalEntry.simple({
        id: supplier.id,
        date: "2026-09-10",
        narration: `${supplier.name} — ${supplier.invoice}`,
        debit: "5700",
        credit: "1110",
        amount: gbp(supplier.amount),
        reference: supplier.invoice,
      }),
    );
  }

  // Three receipts in, one per sales invoice, all cleared together.
  for (const receipt of CUSTOMER_RECEIPTS) {
    ledger = ledger.post(
      JournalEntry.simple({
        id: receipt.id,
        date: "2026-09-20",
        narration: `Northwind Ltd — ${receipt.invoice}`,
        debit: "1110",
        credit: "1130",
        amount: gbp(receipt.amount),
        reference: receipt.invoice,
      }),
    );
  }

  // An ordinary single payment, so the example is not all groups.
  ledger = ledger.post(
    JournalEntry.simple({
      id: "SEP-RENT",
      date: "2026-09-04",
      narration: "September rent",
      debit: "5300",
      credit: "1110",
      amount: gbp("1850.00"),
      reference: "DD-RENT-09",
    }),
  );

  return ledger;
}

/**
 * The bank's version: one line for the BACS run, one for the lump-sum receipt,
 * the rent, and a charge nobody has booked yet.
 */
export const SUPPLIER_RUN_CSV = [
  "Date,Description,Paid Out,Paid In,Balance",
  "01/09/2026,BALANCE BROUGHT FORWARD,,8000.00,8000.00",
  '04/09/2026,"DD RENT, SEPTEMBER 09",1850.00,,6150.00',
  "10/09/2026,BACS SUPPLIER RUN 100926,2138.00,,4012.00",
  "20/09/2026,FPI NORTHWIND LTD INV1042,,5160.00,9172.00",
  "30/09/2026,BANK CHARGES,22.00,,9150.00",
].join("\n");

/** Total of the BACS run, for tests that want the number without adding it up. */
export const SUPPLIER_RUN_TOTAL = SUPPLIER_RUN.reduce(
  (total, supplier) => total.plus(gbp(supplier.amount)),
  Money.zero(GBP),
);

export const CUSTOMER_RECEIPT_TOTAL = CUSTOMER_RECEIPTS.reduce(
  (total, receipt) => total.plus(gbp(receipt.amount)),
  Money.zero(GBP),
);
