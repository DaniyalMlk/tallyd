/**
 * What the books are exposed to.
 *
 * An exposure is an account balance that is owed or owing in a currency the
 * books are not kept in. It has two numbers: the balance in the currency it is
 * denominated in — what the customer actually owes — and the carrying amount in
 * the functional currency, which is the sum of what each movement was booked at
 * on the day it happened. Those two drift apart as the rate moves, and closing
 * the gap is what a revaluation does.
 *
 * The thing that makes a balance an exposure is that its account is denominated
 * in a foreign currency, not that the account is monetary. No monetary flag is
 * needed: a machine bought in euros and carried at historical cost never had a
 * foreign denomination in the first place — it was booked straight to a
 * functional-currency asset account at the rate on the day — so it never shows
 * up here and is never retranslated. That is the right answer, and it falls out
 * of the model rather than being enforced by a rule.
 */

import type { Currency } from "../money/currency.js";
import { Money, sumMoney } from "../money/money.js";
import type { CalendarDate } from "../ledger/date.js";
import { compareDates } from "../ledger/date.js";
import type { Ledger } from "../ledger/ledger.js";
import { ExchangeRate, RateError } from "./rate.js";

export interface Exposure {
  readonly account: string;
  readonly name: string;
  /** The currency the account is denominated in. */
  readonly currency: Currency;
  /** The balance in that currency: what is actually owed or owing. */
  readonly foreignBalance: Money;
  /**
   * What the books carry it at, in the functional currency: the sum of what
   * every movement was booked at, plus any revaluation already posted.
   */
  readonly carryingAmount: Money;
  /**
   * The rate the carrying amount implies. Null when either side is zero — a
   * settled balance has no rate, and neither does one that nets to nothing in
   * one currency but not the other.
   */
  readonly impliedRate: ExchangeRate | null;
  readonly postingCount: number;
  /** The date of the most recent movement, for reports that want to show it. */
  readonly lastMovement: CalendarDate | null;
}

export interface ExposureOptions {
  /** The currency the books are kept in. Defaults to the chart's. */
  functional?: Currency | string;
  /** Only look at these accounts. */
  accounts?: readonly string[];
  /** Never look at these accounts, whatever their denomination. */
  exclude?: readonly string[];
  /** Ignore movements after this date. */
  asAt?: CalendarDate;
  /** Include exposures whose foreign balance has settled to nothing. */
  includeSettled?: boolean;
}

function functionalCodeOf(ledger: Ledger, requested: Currency | string | undefined): string {
  if (requested !== undefined) {
    return typeof requested === "string" ? requested.toUpperCase() : requested.code;
  }
  return ledger.chart?.defaultCurrency.code ?? ledger.currenciesUsed()[0] ?? "GBP";
}

/**
 * Every foreign-currency balance in the ledger.
 *
 * The carrying amount deliberately sums *all* functional postings to the
 * account, not only those carrying a foreign leg. A revaluation moves the
 * carrying amount without moving the foreign balance — that is exactly what it
 * is for — and if it were excluded here, running the revaluation twice would
 * book the same adjustment twice.
 */
export function exposures(ledger: Ledger, options: ExposureOptions = {}): readonly Exposure[] {
  const chart = ledger.chart;
  const functional = functionalCodeOf(ledger, options.functional);
  const only = options.accounts === undefined ? null : new Set(options.accounts);
  const excluded = new Set(options.exclude ?? []);

  interface Running {
    account: string;
    currency: Currency;
    foreign: Money[];
    carrying: Money[];
    postingCount: number;
    lastMovement: CalendarDate | null;
  }

  const running = new Map<string, Running>();

  for (const entry of ledger.all()) {
    if (options.asAt !== undefined && compareDates(entry.date, options.asAt) > 0) continue;
    for (const posting of entry.postings) {
      if (only !== null && !only.has(posting.account)) continue;
      if (excluded.has(posting.account)) continue;

      const declared = chart?.find(posting.account)?.currency;
      const currency = declared ?? posting.foreign?.currency;
      if (currency === undefined || currency.code === functional) continue;

      let state = running.get(posting.account);
      if (state === undefined) {
        state = {
          account: posting.account,
          currency,
          foreign: [],
          carrying: [],
          postingCount: 0,
          lastMovement: null,
        };
        running.set(posting.account, state);
      }

      if (posting.foreign !== null) state.foreign.push(posting.foreign);
      if (posting.amount.currency.code === functional) state.carrying.push(posting.amount);
      state.postingCount += 1;
      state.lastMovement =
        state.lastMovement === null || compareDates(entry.date, state.lastMovement) > 0
          ? entry.date
          : state.lastMovement;
    }
  }

  const out: Exposure[] = [];
  for (const state of running.values()) {
    const foreignBalance = sumMoney(state.foreign, state.currency);
    const carryingAmount = sumMoney(state.carrying, functional);
    if (foreignBalance.isZero && options.includeSettled !== true) continue;

    let impliedRate: ExchangeRate | null = null;
    try {
      impliedRate = ExchangeRate.implied(foreignBalance, carryingAmount);
    } catch (error) {
      if (!(error instanceof RateError)) throw error;
    }

    out.push(
      Object.freeze({
        account: state.account,
        name: chart?.find(state.account)?.name ?? state.account,
        currency: state.currency,
        foreignBalance,
        carryingAmount,
        impliedRate,
        postingCount: state.postingCount,
        lastMovement: state.lastMovement,
      }),
    );
  }

  out.sort((a, b) =>
    a.currency.code === b.currency.code
      ? a.account.localeCompare(b.account)
      : a.currency.code.localeCompare(b.currency.code),
  );
  return Object.freeze(out);
}

/** One open item: a balance on an account attributable to a single reference. */
export interface OpenItem {
  readonly account: string;
  readonly name: string;
  /** Null for movements that belong to the account rather than to any item. */
  readonly reference: string | null;
  readonly currency: Currency;
  readonly foreignBalance: Money;
  readonly carryingAmount: Money;
  readonly impliedRate: ExchangeRate | null;
  readonly lastMovement: CalendarDate | null;
}

/**
 * The same exposures, broken down by the item each movement belongs to.
 *
 * This is the granularity a revaluation has to work at. An account holding two
 * invoices booked at different rates has no single rate it was booked at, and
 * adjusting it as one balance leaves the adjustment attributable to the account
 * but not to either invoice — so settling one of them afterwards would measure
 * against what it was originally booked at rather than what it is now carried
 * at, and count the same rate movement twice.
 */
export function openItems(ledger: Ledger, options: ExposureOptions = {}): readonly OpenItem[] {
  const chart = ledger.chart;
  const functional = functionalCodeOf(ledger, options.functional);
  const only = options.accounts === undefined ? null : new Set(options.accounts);
  const excluded = new Set(options.exclude ?? []);

  interface Running {
    account: string;
    reference: string | null;
    currency: Currency;
    foreign: Money[];
    carrying: Money[];
    lastMovement: CalendarDate | null;
  }

  const running = new Map<string, Running>();

  for (const entry of ledger.all()) {
    if (options.asAt !== undefined && compareDates(entry.date, options.asAt) > 0) continue;
    for (const posting of entry.postings) {
      if (only !== null && !only.has(posting.account)) continue;
      if (excluded.has(posting.account)) continue;

      const declared = chart?.find(posting.account)?.currency;
      const currency = declared ?? posting.foreign?.currency;
      if (currency === undefined || currency.code === functional) continue;

      const reference = entry.referenceFor(posting);
      const key = `${posting.account}\u0000${reference ?? ""}`;
      let state = running.get(key);
      if (state === undefined) {
        state = {
          account: posting.account,
          reference,
          currency,
          foreign: [],
          carrying: [],
          lastMovement: null,
        };
        running.set(key, state);
      }

      if (posting.foreign !== null) state.foreign.push(posting.foreign);
      if (posting.amount.currency.code === functional) state.carrying.push(posting.amount);
      state.lastMovement =
        state.lastMovement === null || compareDates(entry.date, state.lastMovement) > 0
          ? entry.date
          : state.lastMovement;
    }
  }

  const out: OpenItem[] = [];
  for (const state of running.values()) {
    const foreignBalance = sumMoney(state.foreign, state.currency);
    const carryingAmount = sumMoney(state.carrying, functional);
    if (foreignBalance.isZero && carryingAmount.isZero && options.includeSettled !== true) continue;
    if (foreignBalance.isZero && options.includeSettled !== true) continue;

    let impliedRate: ExchangeRate | null = null;
    try {
      impliedRate = ExchangeRate.implied(foreignBalance, carryingAmount);
    } catch (error) {
      if (!(error instanceof RateError)) throw error;
    }

    out.push(
      Object.freeze({
        account: state.account,
        name: chart?.find(state.account)?.name ?? state.account,
        reference: state.reference,
        currency: state.currency,
        foreignBalance,
        carryingAmount,
        impliedRate,
        lastMovement: state.lastMovement,
      }),
    );
  }

  out.sort((a, b) => {
    if (a.currency.code !== b.currency.code) return a.currency.code.localeCompare(b.currency.code);
    if (a.account !== b.account) return a.account.localeCompare(b.account);
    return (a.reference ?? "").localeCompare(b.reference ?? "");
  });
  return Object.freeze(out);
}

/** The exposure on one account, or undefined when there is none. */
export function exposureFor(
  ledger: Ledger,
  account: string,
  options: ExposureOptions = {},
): Exposure | undefined {
  return exposures(ledger, { ...options, accounts: [account], includeSettled: true })[0];
}

/**
 * The exposure attributable to one reference — an invoice number, usually.
 *
 * Settlement needs this: to know what a receipt realises, you have to know what
 * the item being settled was booked at, and that is a property of the invoice
 * rather than of the account it sits in.
 */
export function exposureForReference(
  ledger: Ledger,
  account: string,
  reference: string,
  options: { functional?: Currency | string } = {},
): { foreignBalance: Money; carryingAmount: Money; impliedRate: ExchangeRate | null } | undefined {
  const functional = functionalCodeOf(ledger, options.functional);
  const currency = ledger.chart?.find(account)?.currency;

  const foreign: Money[] = [];
  const carrying: Money[] = [];
  let seen = false;

  for (const entry of ledger.all()) {
    for (const posting of entry.postings) {
      if (posting.account !== account) continue;
      if (entry.referenceFor(posting) !== reference) continue;
      seen = true;
      if (posting.foreign !== null) foreign.push(posting.foreign);
      if (posting.amount.currency.code === functional) carrying.push(posting.amount);
    }
  }
  if (!seen) return undefined;

  const foreignBalance = sumMoney(foreign, currency ?? foreign[0]?.currency ?? functional);
  const carryingAmount = sumMoney(carrying, functional);
  let impliedRate: ExchangeRate | null = null;
  try {
    impliedRate = ExchangeRate.implied(foreignBalance, carryingAmount);
  } catch (error) {
    if (!(error instanceof RateError)) throw error;
  }
  return { foreignBalance, carryingAmount, impliedRate };
}

/** Fixed-width rendering, for the CLI and for test failure messages. */
export function renderExposures(list: readonly Exposure[], functional: string): string {
  if (list.length === 0) return "No foreign-currency balances.";
  const width = Math.max(12, ...list.map((e) => e.name.length));
  const lines = [
    `Foreign-currency balances (books kept in ${functional})`,
    "-".repeat(width + 54),
    "Account".padEnd(8) +
      "Name".padEnd(width + 2) +
      "Balance".padStart(16) +
      "Carried at".padStart(14) +
      "Rate".padStart(12),
  ];
  for (const item of list) {
    lines.push(
      item.account.padEnd(8) +
        item.name.padEnd(width + 2) +
        `${item.foreignBalance.toDecimalString()} ${item.currency.code}`.padStart(16) +
        item.carryingAmount.toDecimalString().padStart(14) +
        (item.impliedRate === null ? "—" : item.impliedRate.toDecimalString(6)).padStart(12),
    );
  }
  return lines.join("\n");
}
