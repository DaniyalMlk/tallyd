/**
 * Synthetic books, and the bank statement that ought to reconcile against them.
 *
 * The hand-written month in `month.ts` is a fixture: it is the same twenty-odd
 * transactions every time, chosen to exercise particular shapes. This is a
 * different tool for a different job — it makes books of any size, and it makes
 * them *hard* on purpose.
 *
 * The point is not volume. Generating a thousand transactions where every bank
 * line is the exact twin of a ledger posting would produce a benchmark that
 * measures nothing, because that is the one case matching is trivially good at.
 * So the generator applies the distortions that actually make reconciliation
 * difficult:
 *
 * - **Settlement lag.** Card takings land two or three days after capture, and
 *   the bank dates them when the money moved, not when the sale happened.
 * - **Fees netted off.** A £480 sale arrives as £473.08. The number in the
 *   books appears nowhere on the statement.
 * - **Batch payments.** A supplier run is nine invoices in the ledger and one
 *   debit at the bank, which is the one-to-many case.
 * - **Bank-only lines.** Charges and interest that nobody booked, because
 *   nobody knew about them until the statement arrived.
 * - **Ledger-only lines.** A cheque written on the 30th that clears in the
 *   following period, which is the timing difference a bridge exists to show.
 * - **Bank descriptors.** The bank writes `FPO ACME LTD 4471`, not
 *   `Invoice 1043 — Acme Ltd`.
 *
 * And because it built the books, it knows the answer. Every generated dataset
 * carries its **ground truth**: which statement lines really came from which
 * ledger postings. That is what turns a benchmark from "how fast" into "how
 * fast, and still right" — without it a performance change that quietly stopped
 * finding a third of the matches would look like an improvement.
 */

import { Money } from "../money/money.js";
import { GBP, type Currency } from "../money/currency.js";
import { standardChart } from "../accounts/standard.js";
import { JournalEntry } from "../ledger/entry.js";
import { Ledger } from "../ledger/ledger.js";
import { addDays, date as toDate, type CalendarDate } from "../ledger/date.js";
import { statementLine, type StatementLine } from "../statement/line.js";
import { Random } from "./random.js";

export interface GeneratorOptions {
  /** Same seed, same books. Default 1. */
  seed?: number;
  /** First day of the first month generated. Default `2026-01-01`. */
  start?: string;
  /** How many months to generate. Default 3. */
  months?: number;
  /**
   * Roughly how many customer invoices a month. Everything else — purchases,
   * card takings, payroll — scales alongside it. Default 12.
   */
  invoicesPerMonth?: number;
  /** Currency for the whole dataset. Default GBP. */
  currency?: Currency;
  /** Bank account code in the standard chart. Default `1110`. */
  bankAccount?: string;
  /**
   * Chance that a ledger cash movement never reaches this statement — a cheque
   * still in the post at the period end. Default 0.04.
   */
  outstandingRate?: number;
  /**
   * Chance the bank adds a line of its own that the books know nothing about.
   * Default 0.03 per movement generated.
   */
  bankOnlyRate?: number;
}

/** One statement line and the ledger postings it was built from. */
export interface TruthLink {
  readonly statementId: string;
  /** `<entryId>#<postingIndex>`, matching `BookLine.id`. */
  readonly bookIds: readonly string[];
}

export interface GeneratedBooks {
  readonly ledger: Ledger;
  /** In statement order: by date, then as the bank happened to write them. */
  readonly statement: readonly StatementLine[];
  readonly truth: readonly TruthLink[];
  readonly bankAccount: string;
  readonly currency: Currency;
  readonly from: CalendarDate;
  readonly to: CalendarDate;
  readonly summary: GeneratedSummary;
}

export interface GeneratedSummary {
  readonly entries: number;
  readonly statementLines: number;
  /** Statement lines a matcher could in principle explain. */
  readonly explainable: number;
  /** Lines the bank raised that the books never saw. */
  readonly bankOnly: number;
  /** Cash movements in the books that never reached the statement. */
  readonly ledgerOnly: number;
  /** Statement lines that stand for more than one ledger posting. */
  readonly grouped: number;
}

const CUSTOMERS = [
  "Northwind Ltd",
  "Acme Industrial",
  "Harbourside Media",
  "Calder & Voss",
  "Peak Analytics",
  "Fenwick Systems",
  "Ravenscroft LLP",
  "Blue Meridian",
  "Tamar Logistics",
  "Orwell Partners",
] as const;

const SUPPLIERS = [
  "Ashgrove Supplies",
  "Kettleby Print",
  "Meridian Hosting",
  "Sandford Office",
  "Wentworth Legal",
  "Bracken Couriers",
  "Halden Utilities",
] as const;

const CARD_MERCHANTS = ["Coffee", "Rail", "Fuel", "Bistro", "Hardware", "Stationery"] as const;

/**
 * How a bank writes a name.
 *
 * Real descriptors are shouted, truncated, prefixed by a scheme code and
 * suffixed by a terminal number. Reproducing that is the whole reason the
 * description rule in the scorer has to work on normalised text.
 */
function bankDescriptor(random: Random, name: string, kind: "in" | "out"): string {
  const upper = name.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const truncated = upper.length > 18 ? upper.slice(0, 18).trim() : upper;
  const scheme = kind === "in" ? random.pick(["BGC", "FPI", "TFR"]) : random.pick(["FPO", "DD", "SO"]);
  const suffix = random.chance(0.5) ? ` ${random.int(1000, 9999)}` : "";
  return `${scheme} ${truncated}${suffix}`;
}

interface PendingLine {
  readonly date: CalendarDate;
  readonly description: string;
  readonly amount: Money;
  readonly reference: string | null;
  readonly bookIds: readonly string[];
}

/**
 * Build a month's worth of business, and the bank's version of it.
 *
 * The two are built together rather than one derived from the other, because
 * the derivation is where the difficulty lives: the bank line for a card
 * settlement is a different amount on a different day with a different name,
 * and that relationship has to be constructed deliberately.
 */
export function generateBooks(options: GeneratorOptions = {}): GeneratedBooks {
  const random = new Random(options.seed ?? 1);
  const currency = options.currency ?? GBP;
  const bank = options.bankAccount ?? "1110";
  const months = Math.max(1, Math.trunc(options.months ?? 3));
  const perMonth = Math.max(1, Math.trunc(options.invoicesPerMonth ?? 12));
  const outstandingRate = options.outstandingRate ?? 0.04;
  const bankOnlyRate = options.bankOnlyRate ?? 0.03;
  const start = toDate(options.start ?? "2026-01-01");

  const money = (units: number, minor = 0): Money =>
    Money.ofMinor(BigInt(units) * 100n + BigInt(minor), currency);

  let ledger = Ledger.empty(standardChart(currency));
  const pending: PendingLine[] = [];
  let entrySeq = 0;
  let ledgerOnly = 0;
  let grouped = 0;

  const nextId = (): string => {
    entrySeq += 1;
    return `GEN-${entrySeq.toString().padStart(5, "0")}`;
  };

  /**
   * Record that a cash movement happened, and decide whether the bank saw it.
   *
   * Returns whether it reached the statement. A movement the bank never saw is
   * not an error — it is the cheque still in the post, and the bridge exists to
   * report exactly that.
   */
  const bankSaw = (
    line: Omit<PendingLine, "bookIds"> & { bookIds: readonly string[] },
  ): boolean => {
    if (random.chance(outstandingRate)) {
      ledgerOnly += line.bookIds.length;
      return false;
    }
    pending.push(line);
    return true;
  };

  const post = (entry: JournalEntry): void => {
    ledger = ledger.post(entry);
  };

  // Opening capital, so the bank balance is never negative.
  const openingId = nextId();
  post(
    JournalEntry.simple({
      id: openingId,
      date: start,
      narration: "Opening balance brought forward",
      debit: bank,
      credit: "3100",
      amount: money(40000),
    }),
  );
  pending.push({
    date: start,
    description: "BALANCE BROUGHT FORWARD",
    amount: money(40000),
    reference: null,
    bookIds: [`${openingId}#0`],
  });

  let dayCursor = start;

  for (let month = 0; month < months; month++) {
    const monthStart = dayCursor;
    const monthLength = 30;

    // --- sales invoiced and later settled ---------------------------------

    for (let i = 0; i < perMonth; i++) {
      const customer = random.pick(CUSTOMERS);
      const invoiceDay = addDays(monthStart, random.int(0, monthLength - 6));
      const net = money(random.skewed(400, 9000));
      const vat = net.times("0.2");
      const gross = net.plus(vat);
      const reference = `INV-${2000 + entrySeq}`;

      const invoiceId = nextId();
      post(
        JournalEntry.create({
          id: invoiceId,
          date: invoiceDay,
          narration: `Invoice — ${customer}`,
          reference,
          tags: ["sales"],
          postings: [
            { account: "1130", amount: gross, memo: customer },
            { account: "4200", amount: net.negated() },
            { account: "2200", amount: vat.negated(), memo: "VAT at 20%" },
          ],
        }),
      );

      // Most invoices are paid inside the window; some are not, and become the
      // receivables that give the ageing report something to bucket.
      if (!random.chance(0.18)) {
        const paidDay = addDays(invoiceDay, random.skewed(3, 40));
        const receiptId = nextId();
        post(
          JournalEntry.simple({
            id: receiptId,
            date: paidDay,
            narration: `Receipt — ${customer}`,
            debit: bank,
            credit: "1130",
            amount: gross,
            reference,
          }),
        );
        bankSaw({
          date: addDays(paidDay, random.chance(0.25) ? 1 : 0),
          description: `${bankDescriptor(random, customer, "in")} ${reference}`,
          amount: gross,
          reference,
          bookIds: [`${receiptId}#0`],
        });
      }
    }

    // --- purchases, some paid singly and some in a batch run --------------

    const purchaseCount = Math.max(2, Math.round(perMonth * 0.8));
    const batchable: { id: string; supplier: string; amount: Money; reference: string }[] = [];

    for (let i = 0; i < purchaseCount; i++) {
      const supplier = random.pick(SUPPLIERS);
      const billDay = addDays(monthStart, random.int(0, monthLength - 8));
      const amount = money(random.skewed(60, 2400));
      const reference = `BILL-${3000 + entrySeq}`;

      const billId = nextId();
      post(
        JournalEntry.create({
          id: billId,
          date: billDay,
          narration: `Bill — ${supplier}`,
          reference,
          tags: ["purchases"],
          postings: [
            { account: "5100", amount, memo: supplier },
            { account: "2100", amount: amount.negated() },
          ],
        }),
      );

      const payDay = addDays(billDay, random.skewed(2, 25));
      const payId = nextId();
      post(
        JournalEntry.simple({
          id: payId,
          date: payDay,
          narration: `Payment — ${supplier}`,
          debit: "2100",
          credit: bank,
          amount,
          reference,
        }),
      );

      // Two in five go into the month's batch run; the rest leave the bank on
      // their own and are ordinary one-to-one matches.
      if (random.chance(0.4)) {
        batchable.push({ id: `${payId}#1`, supplier, amount, reference });
      } else {
        bankSaw({
          date: addDays(payDay, random.chance(0.2) ? 1 : 0),
          description: `${bankDescriptor(random, supplier, "out")} ${reference}`,
          amount: amount.negated(),
          reference,
          bookIds: [`${payId}#1`],
        });
      }
    }

    // The batch: several ledger payments, one debit at the bank. Split into
    // runs of at most six so a busy month produces more than one of them.
    for (let offset = 0; offset < batchable.length; offset += 6) {
      const run = batchable.slice(offset, offset + 6);
      if (run.length === 0) continue;
      if (run.length === 1) {
        const only = run[0] as { id: string; supplier: string; amount: Money; reference: string };
        bankSaw({
          date: addDays(monthStart, monthLength - 4),
          description: `${bankDescriptor(random, only.supplier, "out")} ${only.reference}`,
          amount: only.amount.negated(),
          reference: only.reference,
          bookIds: [only.id],
        });
        continue;
      }
      const total = run.reduce((sum, item) => sum.plus(item.amount), Money.zero(currency));
      const seen = bankSaw({
        date: addDays(monthStart, monthLength - 4),
        // A batch descriptor names the run, not the invoices in it, which is
        // exactly why a group match cannot be made on wording alone.
        description: `BACS SUPPLIER RUN ${random.int(100000, 999999)}`,
        amount: total.negated(),
        reference: null,
        bookIds: run.map((item) => item.id),
      });
      if (seen) grouped += 1;
    }

    // --- card takings, settled late and net of the processor's fee --------

    const cardDays = Math.max(1, Math.round(perMonth / 3));
    for (let i = 0; i < cardDays; i++) {
      const captureDay = addDays(monthStart, random.int(0, monthLength - 5));
      const gross = money(random.skewed(80, 1400), random.int(0, 99));
      const fee = gross.times("0.014").plus(money(0, 20));
      const net = gross.minus(fee);

      const captureId = nextId();
      post(
        JournalEntry.create({
          id: captureId,
          date: captureDay,
          narration: `Card takings, ${captureDay}`,
          postings: [
            { account: "1140", amount: gross, memo: `${random.pick(CARD_MERCHANTS)} terminal` },
            { account: "4100", amount: gross.negated() },
          ],
        }),
      );

      const settleDay = addDays(captureDay, random.int(2, 3));
      const settleId = nextId();
      const reference = `STL-${settleDay.replace(/-/g, "").slice(4)}`;
      post(
        JournalEntry.create({
          id: settleId,
          date: settleDay,
          narration: `Processor settlement for ${captureDay}`,
          reference,
          postings: [
            { account: bank, amount: net, memo: "Net deposit" },
            { account: "5500", amount: fee, memo: "1.4% + 20p" },
            { account: "1140", amount: gross.negated() },
          ],
        }),
      );
      bankSaw({
        date: settleDay,
        description: `SQ *SETTLEMENT ${reference}`,
        amount: net,
        reference,
        bookIds: [`${settleId}#0`],
      });
    }

    // --- the fixed monthly furniture --------------------------------------

    const rentDay = addDays(monthStart, 3);
    const rentId = nextId();
    const rent = money(1850);
    post(
      JournalEntry.simple({
        id: rentId,
        date: rentDay,
        narration: "Monthly rent",
        debit: "5300",
        credit: bank,
        amount: rent,
        reference: "DD-RENT",
      }),
    );
    bankSaw({
      date: rentDay,
      description: "DD PROPERTY RENT",
      amount: rent.negated(),
      reference: "DD-RENT",
      bookIds: [`${rentId}#1`],
    });

    const payrollDay = addDays(monthStart, monthLength - 2);
    const payrollId = nextId();
    const grossPay = money(perMonth * 700);
    const paye = grossPay.times("0.23");
    const netPay = grossPay.minus(paye);
    post(
      JournalEntry.create({
        id: payrollId,
        date: payrollDay,
        narration: "Payroll",
        reference: "PAYROLL",
        postings: [
          { account: "5200", amount: grossPay },
          { account: bank, amount: netPay.negated(), memo: "Net pay" },
          { account: "2300", amount: paye.negated(), memo: "PAYE and NI" },
        ],
      }),
    );
    bankSaw({
      date: payrollDay,
      description: "BACS PAYROLL",
      amount: netPay.negated(),
      reference: "PAYROLL",
      bookIds: [`${payrollId}#1`],
    });

    dayCursor = addDays(monthStart, monthLength);
  }

  // --- lines only the bank knows about -------------------------------------

  const totalDays = months * 30;
  const bankOnlyCount = Math.round(pending.length * bankOnlyRate);
  for (let i = 0; i < bankOnlyCount; i++) {
    const day = addDays(start, random.int(0, Math.max(0, totalDays - 1)));
    const charge = random.chance(0.7);
    pending.push({
      date: day,
      description: charge ? "ACCOUNT MAINTENANCE FEE" : "CREDIT INTEREST",
      amount: charge ? money(0, random.int(150, 900)).negated() : money(0, random.int(5, 120)),
      reference: null,
      bookIds: [],
    });
  }

  // --- assemble the statement ----------------------------------------------
  //
  // Sorted by date; ties broken by a stable key rather than by insertion order,
  // because insertion order encodes how the books were built and a real
  // statement carries no such hint.

  const ordered = [...pending].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const left = `${a.amount.minorUnits}|${a.description}`;
    const right = `${b.amount.minorUnits}|${b.description}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });

  let running = Money.zero(currency);
  const statement: StatementLine[] = [];
  const truth: TruthLink[] = [];
  let bankOnly = 0;

  ordered.forEach((line, index) => {
    running = running.plus(line.amount);
    const id = `BANK-${(index + 1).toString().padStart(5, "0")}`;
    statement.push(
      statementLine({
        id,
        date: line.date,
        description: line.description,
        amount: line.amount,
        balance: running,
        ...(line.reference === null ? {} : { reference: line.reference }),
        sourceRow: index,
      }),
    );
    if (line.bookIds.length === 0) bankOnly += 1;
    else truth.push(Object.freeze({ statementId: id, bookIds: Object.freeze([...line.bookIds]) }));
  });

  const from = start;
  const to = addDays(start, totalDays - 1);

  return Object.freeze({
    ledger,
    statement: Object.freeze(statement),
    truth: Object.freeze(truth),
    bankAccount: bank,
    currency,
    from,
    to,
    summary: Object.freeze({
      entries: ledger.size,
      statementLines: statement.length,
      explainable: truth.length,
      bankOnly,
      ledgerOnly,
      grouped,
    }),
  });
}

const CSV_QUOTE = /[",\n\r]/;

function csvField(value: string): string {
  return CSV_QUOTE.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * The generated statement as a CSV a bank might actually export: a preamble
 * before the header, `DD/MM/YYYY` dates, and separate paid-in and paid-out
 * columns rather than one signed amount.
 */
export function statementCsv(generated: GeneratedBooks): string {
  const rows: string[] = [
    "Generated Bank plc",
    `Account statement ${generated.from} to ${generated.to}`,
    "",
    "Date,Description,Reference,Paid Out,Paid In,Balance",
  ];
  for (const line of generated.statement) {
    const [year, month, day] = line.date.split("-") as [string, string, string];
    const paidIn = line.amount.isPositive ? line.amount.toDecimalString() : "";
    const paidOut = line.amount.isNegative ? line.amount.abs().toDecimalString() : "";
    rows.push(
      [
        `${day}/${month}/${year}`,
        csvField(line.description),
        csvField(line.reference ?? ""),
        paidOut,
        paidIn,
        line.balance?.toDecimalString() ?? "",
      ].join(","),
    );
  }
  return `${rows.join("\n")}\n`;
}
