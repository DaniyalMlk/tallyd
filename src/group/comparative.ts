/**
 * The same group, at two reporting dates.
 *
 * A consolidated balance sheet is published with the previous year beside it,
 * and until now there was no way to produce the previous year: `consolidate`
 * takes one date and answers about that date. The obvious fix is to call it
 * twice, which is what this does, but the interesting part is not the second
 * call. It is what has to be true for the two results to be comparable at all,
 * and what to do when it is not.
 *
 * Three things can differ between two consolidations of the same group and
 * only one of them is benign.
 *
 * - **The presentation currency.** Two consolidations in different currencies
 *   have nothing to say to each other, and comparing them line by line would
 *   produce a movement schedule made of exchange rates. Refused outright.
 * - **The set of entities.** A company consolidated this year and not last was
 *   acquired; one consolidated last year and not this was sold or lost. Both
 *   are ordinary and both are reported, because a reader looking at a line
 *   that doubled deserves to know a company appeared in it.
 * - **The chart.** Books kept on different charts are already the ordinary
 *   case within one consolidation, and across two the same is true: an account
 *   used this year and not last is simply a row with an empty comparative,
 *   which is what a real set of statements shows.
 *
 * The comparative trial balance is built from the two consolidated ledgers
 * rather than from the aggregations, because the consolidated ledger is what
 * the balance sheet is drawn from. Every adjustment — eliminations, goodwill,
 * the outside stake — is already in it, so the comparison is between two sets
 * of group accounts and not between two piles of subsidiaries.
 */

import { Money } from "../money/money.js";
import type { Currency } from "../money/currency.js";
import type { AccountType } from "../accounts/types.js";
import type { CalendarDate } from "../ledger/date.js";
import { trialBalance } from "../ledger/trialBalance.js";
import { GroupError, type GroupStructure } from "./structure.js";
import { type Consolidation, type ConsolidationOptions, consolidate } from "./consolidate.js";
import type { EntityLedgers } from "./aggregate.js";
import {
  type MovementOptions,
  type MovementSchedule,
  type NetAssetsMovement,
  type NciMovement,
  nciMovements,
  nciSchedule,
  netAssetsMovements,
  translationReserveSchedule,
} from "./movement.js";

export interface ComparativeRow {
  readonly account: string;
  readonly name: string;
  readonly type: AccountType | null;
  /** The balance at the reporting date, signed. */
  readonly current: Money;
  /** The balance at the comparative date, signed. */
  readonly prior: Money;
  readonly movement: Money;
  /** True when the account appears in only one of the two. */
  readonly newThisPeriod: boolean;
  readonly goneThisPeriod: boolean;
}

export interface ComparativeConsolidation {
  readonly group: GroupStructure;
  readonly presentation: Currency;
  readonly asAt: CalendarDate;
  readonly comparativeAsAt: CalendarDate;
  readonly current: Consolidation;
  readonly prior: Consolidation;
  readonly rows: readonly ComparativeRow[];
  readonly netAssets: readonly NetAssetsMovement[];
  readonly nciByEntity: readonly NciMovement[];
  readonly nci: MovementSchedule;
  readonly translationReserve: MovementSchedule;
  /** Consolidated at the reporting date and not at the comparative one. */
  readonly entered: readonly string[];
  /** Consolidated at the comparative date and not at the reporting one. */
  readonly left: readonly string[];
  /** True when both consolidations balance and both schedules tie. */
  readonly sound: boolean;
}

export interface ComparativeOptions extends MovementOptions {
  /** Include accounts whose balance is nil in both columns. */
  includeZero?: boolean;
}

/** Pair two consolidations of the same group. */
export function compareConsolidations(
  prior: Consolidation,
  current: Consolidation,
  options: ComparativeOptions,
): ComparativeConsolidation {
  const presentation = current.presentation;
  if (prior.presentation.code !== presentation.code) {
    throw new GroupError(
      `The comparative is presented in ${prior.presentation.code} and this period in ` +
        `${presentation.code}. Two consolidations in different currencies cannot be ` +
        `set beside each other; restate one of them first.`,
    );
  }
  if (prior.group.name !== current.group.name) {
    throw new GroupError(
      `The comparative is for "${prior.group.name}" and this period for ` +
        `"${current.group.name}". These are not the same group.`,
    );
  }
  if (prior.asAt >= current.asAt) {
    throw new GroupError(
      `The comparative date ${prior.asAt} is not before the reporting date ${current.asAt}.`,
    );
  }

  const zero = Money.zero(presentation);
  // A row that eliminated to nil is absent from a trial balance, and an
  // intercompany account eliminating to nil is exactly the row a reader may
  // want to see rather than have hidden. So `includeZero` goes back to the
  // consolidated ledger and asks again rather than filtering what it was given.
  const rowsOf = (result: Consolidation) =>
    options.includeZero === true
      ? trialBalance(result.ledger, {
          currency: presentation,
          asAt: result.asAt,
          includeZero: true,
        }).rows
      : result.trialBalance.rows;
  const currentRows = new Map(rowsOf(current).map((r) => [r.account, r] as const));
  const priorRows = new Map(rowsOf(prior).map((r) => [r.account, r] as const));
  const accounts = [...new Set([...currentRows.keys(), ...priorRows.keys()])].sort((a, b) =>
    a.localeCompare(b),
  );

  const rows: ComparativeRow[] = [];
  for (const account of accounts) {
    const now = currentRows.get(account);
    const before = priorRows.get(account);
    const currentAmount = now?.signed ?? zero;
    const priorAmount = before?.signed ?? zero;
    if (
      options.includeZero !== true &&
      currentAmount.isZero &&
      priorAmount.isZero
    ) {
      continue;
    }
    rows.push(
      Object.freeze({
        account,
        name: now?.name ?? before?.name ?? account,
        type: now?.type ?? before?.type ?? null,
        current: currentAmount,
        prior: priorAmount,
        movement: currentAmount.minus(priorAmount),
        newThisPeriod: now !== undefined && before === undefined,
        goneThisPeriod: now === undefined && before !== undefined,
      }),
    );
  }

  const currentEntities = new Set(current.aggregation.entities.map((c) => c.entity));
  const priorEntities = new Set(prior.aggregation.entities.map((c) => c.entity));
  const entered = [...currentEntities].filter((e) => !priorEntities.has(e)).sort();
  const left = [...priorEntities].filter((e) => !currentEntities.has(e)).sort();

  const nci = nciSchedule(prior, current, options);
  const reserve = translationReserveSchedule(prior, current);

  return Object.freeze({
    group: current.group,
    presentation,
    asAt: current.asAt,
    comparativeAsAt: prior.asAt,
    current,
    prior,
    rows: Object.freeze(rows),
    netAssets: netAssetsMovements(prior, current, options),
    nciByEntity: nciMovements(prior, current, options),
    nci,
    translationReserve: reserve,
    entered: Object.freeze(entered),
    left: Object.freeze(left),
    sound:
      current.balanced && prior.balanced && nci.reconciles && reserve.reconciles,
  });
}

export interface ComparativeConsolidationOptions {
  /** The reporting period. */
  current: ConsolidationOptions;
  /** The comparative period. The rate table defaults to this period's. */
  prior: Omit<ConsolidationOptions, "rates"> & { rates?: ConsolidationOptions["rates"] };
  includeZero?: boolean;
}

/**
 * Consolidate the same books at two dates and set the results beside each
 * other.
 *
 * The same ledgers go into both, which is the point: an entity's books are a
 * complete history, so last year's balance sheet is a question about the same
 * file and a different date. Nothing needs to have been kept from last time.
 */
export function consolidateComparative(
  group: GroupStructure,
  ledgers: EntityLedgers,
  options: ComparativeConsolidationOptions,
): ComparativeConsolidation {
  const current = consolidate(group, ledgers, options.current);
  const priorRates = options.prior.rates ?? options.current.rates;
  const prior = consolidate(group, ledgers, { ...options.prior, rates: priorRates });
  return compareConsolidations(prior, current, {
    rates: options.current.rates,
    ...(options.current.rounding === undefined ? {} : { rounding: options.current.rounding }),
    ...(options.includeZero === undefined ? {} : { includeZero: options.includeZero }),
  });
}

export function renderComparative(result: ComparativeConsolidation): string {
  const width = Math.max(24, ...result.rows.map((r) => r.name.length));
  const column = 16;
  const lines: string[] = [];
  lines.push(
    `${result.group.name} — consolidated as at ${result.asAt}, ` +
      `with ${result.comparativeAsAt} beside it (${result.presentation.code})`,
  );
  lines.push("-".repeat(10 + width + column * 3));
  lines.push(
    "Account".padEnd(10) +
      "Name".padEnd(width + 2) +
      result.asAt.padStart(column) +
      result.comparativeAsAt.padStart(column) +
      "Movement".padStart(column),
  );
  for (const row of result.rows) {
    lines.push(
      row.account.padEnd(10) +
        row.name.padEnd(width + 2) +
        row.current.toDecimalString().padStart(column) +
        (row.newThisPeriod ? "—" : row.prior.toDecimalString()).padStart(column) +
        row.movement.toDecimalString().padStart(column),
    );
  }
  lines.push("-".repeat(10 + width + column * 3));
  for (const entity of result.entered) {
    lines.push(
      `${entity} ${result.group.get(entity).name} is consolidated this period and was not last.`,
    );
  }
  for (const entity of result.left) {
    lines.push(`${entity} was consolidated last period and is not this one.`);
  }
  if (!result.sound) {
    lines.push("One of the two consolidations does not balance, or a schedule does not tie.");
  }
  return lines.join("\n");
}
