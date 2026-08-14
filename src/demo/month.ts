/**
 * A worked month for a small consultancy.
 *
 * This is the fixture the reports are developed against, and it is deliberately
 * awkward in the ways real books are: a card payment that settles two days late
 * net of a processor fee, an expense split three ways across projects, and a
 * mistaken entry that has to be reversed rather than deleted.
 */

import { Money } from "../money/money.js";
import { GBP } from "../money/currency.js";
import { standardChart } from "../accounts/standard.js";
import { JournalEntry } from "../ledger/entry.js";
import { Ledger } from "../ledger/ledger.js";

const gbp = (text: string) => Money.parse(text, GBP);

export function demoLedger(): Ledger {
  const chart = standardChart(GBP);
  let ledger = Ledger.empty(chart);

  ledger = ledger.post(
    JournalEntry.simple({
      id: "JE-001",
      date: "2026-08-01",
      narration: "Opening share capital",
      debit: "1110",
      credit: "3100",
      amount: gbp("25000.00"),
    }),
  );

  // Invoice with VAT: one debit, two credits.
  ledger = ledger.post(
    JournalEntry.create({
      id: "JE-002",
      date: "2026-08-03",
      narration: "Invoice 1001 — Northwind Ltd",
      reference: "INV-1001",
      tags: ["sales", "northwind"],
      postings: [
        { account: "1130", amount: gbp("7200.00"), memo: "Northwind, 30 day terms" },
        { account: "4200", amount: gbp("-6000.00") },
        { account: "2200", amount: gbp("-1200.00"), memo: "VAT at 20%" },
      ],
    }),
  );

  ledger = ledger.post(
    JournalEntry.simple({
      id: "JE-003",
      date: "2026-08-04",
      narration: "August rent",
      debit: "5300",
      credit: "1110",
      amount: gbp("1850.00"),
      reference: "DD-RENT-08",
    }),
  );

  // A card sale: captured on the 5th, settled on the 7th net of a 1.4% + 20p
  // fee. This is the shape that makes naive statement matching fail — the
  // deposit that lands in the bank is not the amount anyone invoiced.
  const gross = gbp("480.00");
  const fee = gross.times("0.014").plus(gbp("0.20"));
  const net = gross.minus(fee);

  ledger = ledger.post(
    JournalEntry.create({
      id: "JE-004",
      date: "2026-08-05",
      narration: "Card sales, 5 Aug",
      postings: [
        { account: "1140", amount: gross, memo: "Captured by processor" },
        { account: "4100", amount: gross.negated() },
      ],
    }),
  );

  ledger = ledger.post(
    JournalEntry.create({
      id: "JE-005",
      date: "2026-08-07",
      narration: "Processor settlement for 5 Aug",
      reference: "STL-0805",
      postings: [
        { account: "1110", amount: net, memo: "Net deposit" },
        { account: "5500", amount: fee, memo: "1.4% + 20p" },
        { account: "1140", amount: gross.negated() },
      ],
    }),
  );

  // One expense split across three cost lines without losing a penny.
  const licence = gbp("299.00");
  const [a, b, c] = licence.allocate([50, 30, 20]) as [Money, Money, Money];
  ledger = ledger.post(
    JournalEntry.create({
      id: "JE-006",
      date: "2026-08-09",
      narration: "Annual toolchain licence, split by project",
      reference: "SUB-9931",
      postings: [
        { account: "5400", amount: a, memo: "Project Alpha (50%)" },
        { account: "5400", amount: b, memo: "Project Beta (30%)" },
        { account: "5400", amount: c, memo: "Internal (20%)" },
        { account: "1110", amount: licence.negated() },
      ],
    }),
  );

  ledger = ledger.post(
    JournalEntry.simple({
      id: "JE-007",
      date: "2026-08-12",
      narration: "Invoice 1001 settled",
      debit: "1110",
      credit: "1130",
      amount: gbp("7200.00"),
      reference: "INV-1001",
    }),
  );

  // Posted to the wrong account, then corrected the way accounting requires:
  // by reversal, not by editing history.
  ledger = ledger.post(
    JournalEntry.simple({
      id: "JE-008",
      date: "2026-08-14",
      narration: "Client dinner",
      debit: "5600",
      credit: "1110",
      amount: gbp("142.50"),
    }),
  );
  ledger = ledger.reverse("JE-008", {
    id: "JE-009",
    date: "2026-08-15",
    narration: "Reverse JE-008 — miscoded to Travel",
  });
  ledger = ledger.post(
    JournalEntry.simple({
      id: "JE-010",
      date: "2026-08-15",
      narration: "Client dinner — recoded",
      debit: "5700",
      credit: "1110",
      amount: gbp("142.50"),
    }),
  );

  ledger = ledger.post(
    JournalEntry.create({
      id: "JE-011",
      date: "2026-08-28",
      narration: "August payroll",
      postings: [
        { account: "5200", amount: gbp("9400.00") },
        { account: "2300", amount: gbp("-2180.00"), memo: "PAYE and NI" },
        { account: "1110", amount: gbp("-7220.00") },
      ],
    }),
  );

  ledger = ledger.post(
    JournalEntry.simple({
      id: "JE-012",
      date: "2026-08-31",
      narration: "Bank charges",
      debit: "5800",
      credit: "1110",
      amount: gbp("18.00"),
    }),
  );

  return ledger;
}

/** The processor fee the demo ledger books, exposed for tests and reports. */
export const DEMO_CARD_FEE = gbp("480.00").times("0.014").plus(gbp("0.20"));
