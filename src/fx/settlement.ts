/**
 * Realised gains and losses on settlement.
 *
 * The revaluation says what a balance is worth today. Settlement says what it
 * turned out to be worth: an invoice raised at 0.8400 and paid at 0.8600 was
 * never really worth 840.00 GBP, and the day the money lands is the day that
 * stops being a matter of opinion.
 *
 * The two have to agree, and there is exactly one way to make them: settlement
 * measures against the *carrying amount*, not against the original invoice
 * rate. If March's revaluation has already moved the receivable to the March
 * close, then April's receipt only realises what happened after March — the
 * rest was booked as unrealised in the period it belonged to. Measuring
 * against the invoice rate instead would book the January-to-March movement
 * twice, once as unrealised and once as realised, and the two would sum to
 * more than the rate ever moved.
 */

import type { Currency } from "../money/currency.js";
import { currency as lookupCurrency } from "../money/currency.js";
import { Money } from "../money/money.js";
import { type RoundingMode, divideRound } from "../money/rounding.js";
import { date as parseDate } from "../ledger/date.js";
import { JournalEntry, type PostingInput } from "../ledger/entry.js";
import type { Ledger } from "../ledger/ledger.js";
import { ExchangeRate } from "./rate.js";
import { exposureFor, exposureForReference } from "./exposure.js";
import type { RateTable } from "./table.js";

export class SettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementError";
  }
}

export interface SettlementOptions {
  id: string;
  date: string;
  /** The foreign-currency account being cleared: a receivable or a payable. */
  account: string;
  /** Where the money went or came from — a bank account, in the books' currency. */
  bankAccount: string;
  /**
   * The foreign amount settled, unsigned. Omit to settle the whole balance,
   * which is the common case and the one that leaves nothing behind.
   */
  amount?: Money;
  /** Narrow the item to one invoice rather than the whole account balance. */
  reference?: string;
  /** The rate on the day the money moved. Taken from `rates` when absent. */
  rate?: ExchangeRate;
  rates?: RateTable;
  /**
   * What actually hit the bank, in the functional currency. Given this, the
   * rate is implied rather than looked up — which is the honest reading when a
   * bank has already told you what it converted at, fees and all.
   */
  settledFor?: Money;
  functional?: Currency | string;
  gainAccount?: string;
  lossAccount?: string;
  narration?: string;
  rounding?: RoundingMode;
  tags?: readonly string[];
}

export interface Settlement {
  /** The foreign amount cleared. */
  readonly settled: Money;
  /** What the books were carrying that portion at. */
  readonly carriedAt: Money;
  /** What it turned into: the functional amount that moved through the bank. */
  readonly received: Money;
  /** received - carriedAt, from the account's point of view. Positive is a gain. */
  readonly realised: Money;
  readonly rate: ExchangeRate;
  /** The rate the carrying amount implied before this settlement. */
  readonly carryingRate: ExchangeRate;
  /** True when this clears the balance rather than part of it. */
  readonly full: boolean;
  readonly entry: JournalEntry;
}

const DEFAULT_GAIN = "4400";
const DEFAULT_LOSS = "5950";

/**
 * Book a settlement, realising whatever the rate did in the meantime.
 *
 * A partial settlement takes its share of the carrying amount pro rata. That is
 * the only allocation that leaves the remaining balance carried at the same
 * rate it was before — settling half a receivable should not change what the
 * other half is carried at.
 */
export function settleForeignItem(ledger: Ledger, options: SettlementOptions): Settlement {
  const when = parseDate(options.date);
  const functional =
    options.functional === undefined
      ? (ledger.chart?.defaultCurrency ?? lookupCurrency("GBP"))
      : typeof options.functional === "string"
        ? lookupCurrency(options.functional)
        : options.functional;
  const rounding = options.rounding ?? "half-even";

  const item =
    options.reference === undefined
      ? exposureFor(ledger, options.account, { functional })
      : exposureForReference(ledger, options.account, options.reference, { functional });

  if (item === undefined) {
    const what =
      options.reference === undefined
        ? `Account ${options.account} has no balance to settle`
        : `Nothing on ${options.account} carries the reference ${options.reference}`;
    throw new SettlementError(what);
  }
  if (item.foreignBalance.isZero) {
    throw new SettlementError(
      `${options.account}${options.reference === undefined ? "" : ` / ${options.reference}`} ` +
        `is already settled`,
    );
  }
  if (item.impliedRate === null) {
    throw new SettlementError(
      `Cannot tell what ${options.account} is carried at: ${item.foreignBalance.toString()} ` +
        `against ${item.carryingAmount.toString()}`,
    );
  }

  // The balance's own sign says which way this goes: a receivable is a debit
  // balance being credited away, a payable is a credit balance being debited.
  const outstanding = item.foreignBalance;
  const requested = options.amount;
  let settledMagnitude: Money;
  if (requested === undefined) {
    settledMagnitude = outstanding.abs();
  } else {
    if (requested.currency.code !== outstanding.currency.code) {
      throw new SettlementError(
        `${options.account} is denominated in ${outstanding.currency.code}, not ` +
          `${requested.currency.code}`,
      );
    }
    settledMagnitude = requested.abs();
    if (settledMagnitude.greaterThan(outstanding.abs())) {
      throw new SettlementError(
        `Cannot settle ${settledMagnitude.toString()} against an outstanding ` +
          `${outstanding.abs().toString()}`,
      );
    }
  }
  if (settledMagnitude.isZero) throw new SettlementError("Cannot settle nothing");

  const full = settledMagnitude.equals(outstanding.abs());
  // Signed the same way as the balance: this is the portion being cleared.
  const settled = outstanding.isNegative ? settledMagnitude.negated() : settledMagnitude;

  // Pro-rata share of the carrying amount, as one exact bigint division rather
  // than a decimal share that would round twice. A full settlement takes the
  // whole carrying amount outright, so nothing can be left stranded by a
  // rounding at the last instalment.
  const carriedAt = full
    ? item.carryingAmount
    : Money.ofMinor(
        divideRound(
          item.carryingAmount.minorUnits * settledMagnitude.minorUnits,
          outstanding.abs().minorUnits,
          rounding,
        ),
        functional,
      );

  const rate =
    options.settledFor !== undefined
      ? ExchangeRate.implied(settled, options.settledFor)
      : (options.rate ??
        (options.rates === undefined
          ? undefined
          : options.rates.lookup(outstanding.currency, functional, when).rate));
  if (rate === undefined) {
    throw new SettlementError("A settlement needs a rate, a rate table, or the amount received");
  }
  if (rate.base.code !== outstanding.currency.code || rate.quote.code !== functional.code) {
    throw new SettlementError(
      `Settling a ${outstanding.currency.code} balance into ${functional.code} needs a ` +
        `${outstanding.currency.code}/${functional.code} rate, got ${rate.pair}`,
    );
  }

  const received =
    options.settledFor !== undefined ? options.settledFor : rate.convert(settled, rounding);
  const realised = received.minus(carriedAt);

  const gainAccount = options.gainAccount ?? DEFAULT_GAIN;
  const lossAccount = options.lossAccount ?? DEFAULT_LOSS;
  const chart = ledger.chart;

  const postings: PostingInput[] = [
    // Clear the foreign item at what it was carried at, taking the foreign
    // amount with it so the balance in its own currency comes down too.
    {
      account: options.account,
      amount: carriedAt.negated(),
      foreign: settled.negated(),
      memo: `Settled at ${rate.toDecimalString(6)}`,
    },
    // The money that actually moved.
    { account: options.bankAccount, amount: received, memo: `${settled.toString()} settled` },
  ];

  if (!realised.isZero) {
    const account = realised.isPositive ? gainAccount : lossAccount;
    if (chart !== undefined && !chart.isPostable(account)) {
      throw new SettlementError(`The account ${account} is not one this chart can post to`);
    }
    postings.push({
      account,
      amount: realised.negated(),
      memo: `Carried at ${item.impliedRate.toDecimalString(6)}, settled at ${rate.toDecimalString(6)}`,
    });
  }

  const entry = JournalEntry.create(
    {
      id: options.id,
      date: when,
      narration:
        options.narration ??
        `Settlement of ${settledMagnitude.toString()} on ${options.account}`,
      postings,
      ...(options.reference === undefined ? {} : { reference: options.reference }),
      tags: options.tags ?? ["fx", "realised"],
    },
    chart,
  );

  return Object.freeze({
    settled,
    carriedAt,
    received,
    realised,
    rate,
    carryingRate: item.impliedRate,
    full,
    entry,
  });
}

/** Settle and post in one step. */
export function applySettlement(ledger: Ledger, options: SettlementOptions): Ledger {
  return ledger.post(settleForeignItem(ledger, options).entry);
}
