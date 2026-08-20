/**
 * Bringing several sets of books onto one page.
 *
 * Aggregation is the mechanical half of consolidation and it has to happen
 * before any of the interesting half can. Nothing is eliminated here and
 * nothing is apportioned: every controlled entity's trial balance is restated
 * into the group's presentation currency and added account by account, in
 * full, including the parts of it that belong to somebody else. A subsidiary
 * held 60% contributes 100% of its assets, because the group controls all of
 * them; that the other 40% of the equity belongs to outside shareholders is
 * settled later, as a claim, and not by adding up less of the balance sheet.
 *
 * Two things are worth being careful about.
 *
 * The first is that each entity's translation carries its own adjustment — the
 * residual of translating assets at one rate, income at another and equity at
 * a third — and those adjustments do not cancel. They are kept per entity as
 * well as in total, because the group's translation reserve is the sum of the
 * subsidiaries' and a reader is entitled to see which subsidiary moved it.
 *
 * The second is that the same account code can mean different things in books
 * that were never kept on one chart. Nothing here can fix that, but it can say
 * so: where two entities give a code different names, the disagreement is
 * reported rather than resolved by whichever entity happened to be first.
 */

import type { Currency } from "../money/currency.js";
import { Money, sumMoney } from "../money/money.js";
import type { RoundingMode } from "../money/rounding.js";
import type { AccountType } from "../accounts/types.js";
import type { CalendarDate, DateRange } from "../ledger/date.js";
import { date as parseDate } from "../ledger/date.js";
import type { Ledger } from "../ledger/ledger.js";
import type { AverageMethod } from "../fx/average.js";
import type { RateTable } from "../fx/table.js";
import { type Translation, translate } from "../fx/translate.js";
import { closingEntry } from "../ledger/close.js";
import { GroupError, type GroupStructure } from "./structure.js";
import { type ControlWindow, controlWindow } from "./timeline.js";

/** The books of each entity, by entity code. */
export type EntityLedgers = ReadonlyMap<string, Ledger> | Readonly<Record<string, Ledger>>;

export interface CombinedRow {
  readonly account: string;
  readonly name: string;
  readonly type: AccountType | null;
  /** The line as the group reads it, in the presentation currency. */
  readonly total: Money;
  /** What each entity put into it. Entities contributing nothing are absent. */
  readonly byEntity: ReadonlyMap<string, Money>;
}

export interface EntityContribution {
  readonly entity: string;
  readonly functional: Currency;
  readonly translation: Translation;
  /** That entity's share of the group's translation reserve. */
  readonly translationAdjustment: Money;
  /** How much of the reporting period the group controlled it for. */
  readonly control: ControlWindow;
  /**
   * Whether that window was applied. False only when the caller asked for the
   * whole period regardless, so a reader is never shown a window beside
   * figures that ignore it.
   */
  readonly windowApplied: boolean;
  /**
   * The result taken to reserves before translating, because it was earned
   * before the group controlled the company. Nil for an entity held all period.
   */
  readonly preAcquisitionResult: Money;
}

export interface NameConflict {
  readonly account: string;
  readonly names: readonly { entity: string; name: string }[];
}

export interface Aggregation {
  readonly presentation: Currency;
  readonly asAt: CalendarDate;
  readonly period: DateRange;
  readonly entities: readonly EntityContribution[];
  readonly rows: readonly CombinedRow[];
  /** The sum of the entities' translation adjustments. */
  readonly translationAdjustment: Money;
  readonly totalDebit: Money;
  readonly totalCredit: Money;
  readonly balanced: boolean;
  /** Entities in the structure that were not added in, and why. */
  readonly excluded: readonly { entity: string; reason: string }[];
  readonly nameConflicts: readonly NameConflict[];
}

export interface AggregationOptions {
  rates: RateTable;
  /** Balance sheet date, and the date of the closing rate. */
  asAt: string;
  /** The reporting period the average rate covers. */
  period?: DateRange;
  averageMethod?: AverageMethod;
  equityBasis?: "historical" | "closing";
  /**
   * Accounts to hold at the rate on the day each movement happened. The
   * investment in a subsidiary belongs here: it is carried at what was paid,
   * and what was paid is a fact about the day of the purchase.
   */
  historicalAccounts?: readonly string[];
  rounding?: RoundingMode;
  includeZero?: boolean;
  /**
   * Where an entity's pre-acquisition result goes when its books are closed at
   * the date control was obtained. Retained earnings by default.
   */
  reserves?: string;
  /**
   * Add an entity acquired part-way through the period in full anyway, as it
   * was before. Off by default: the honest answer is that only the part of the
   * period the group controlled the company for is the group's.
   */
  wholePeriodRegardless?: boolean;
}

function ledgerFor(ledgers: EntityLedgers, code: string): Ledger | undefined {
  return ledgers instanceof Map
    ? ledgers.get(code)
    : (ledgers as Readonly<Record<string, Ledger>>)[code];
}

/**
 * Translate and add every controlled entity's trial balance.
 *
 * An entity in the structure with no books is an error rather than a zero: a
 * consolidation that quietly left out a subsidiary because its file was
 * missing would balance perfectly and be wrong.
 */
export function aggregate(
  group: GroupStructure,
  ledgers: EntityLedgers,
  options: AggregationOptions,
): Aggregation {
  const presentation = group.presentation;
  const asAt = parseDate(options.asAt);
  const rounding = options.rounding ?? "half-even";

  const consolidated = group.consolidated();
  const missing = consolidated.filter((e) => ledgerFor(ledgers, e.code) === undefined);
  if (missing.length > 0) {
    throw new GroupError(
      `No books for ${missing.map((e) => e.code).join(", ")}. A consolidation cannot ` +
        `leave a controlled entity out and still be a consolidation.`,
    );
  }

  const contributions: EntityContribution[] = [];
  const totals = new Map<string, Money>();
  const byEntity = new Map<string, Map<string, Money>>();
  const meta = new Map<string, { name: string; type: AccountType | null }>();
  const names = new Map<string, Map<string, string>>();
  const order: string[] = [];

  // The reporting period each entity's window is cut out of. Where none was
  // given there is nothing to cut: a consolidation with no period is a
  // consolidation about one date, and every entity is taken to have been the
  // group's for all of it.
  const reportingPeriod = options.period ?? { from: asAt, to: asAt };

  for (const entity of consolidated) {
    const original = ledgerFor(ledgers, entity.code) as Ledger;
    const control = controlWindow(entity, reportingPeriod);
    if (control.window === null && !control.acquiredDuring) {
      throw new GroupError(
        `${entity.code} was ${control.reason}, so it cannot be consolidated as at ` +
          `${asAt}. Either the acquisition date or the reporting date is wrong.`,
      );
    }

    // A company acquired part-way through the period has its own books closed
    // at the date control was obtained — as a view, not a rewrite. What is
    // left on the income accounts afterwards is the group's result, and what
    // was taken off them is pre-acquisition profit sitting in the equity that
    // the consolidation eliminates against the investment.
    let ledger = original;
    let windowApplied = true;
    let preAcquisitionResult = Money.zero(entity.currency);
    if (control.closeAt !== null && options.wholePeriodRegardless === true) {
      windowApplied = false;
    }
    if (control.closeAt !== null && options.wholePeriodRegardless !== true) {
      const reserves = options.reserves ?? "3200";
      const closing = closingEntry(original, control.closeAt, {
        currency: entity.currency,
        reserves,
        id: `PRE-ACQ-${entity.code}`,
        narration:
          `${entity.code} — result to ${control.closeAt} is pre-acquisition and ` +
          `belongs to the seller`,
        tags: ["consolidation", "pre-acquisition"],
      });
      if (closing !== null) {
        // Credit-positive, the way a result reads, and the way
        // `profitForPeriod` reads on the other side of the acquisition date.
        preAcquisitionResult = closing.postings
          .filter((posting) => posting.account === reserves)
          .reduce((running, posting) => running.plus(posting.amount), Money.zero(entity.currency))
          .negated();
        ledger = original.post(closing);
      }
    }

    const translation = translate(ledger, {
      presentation,
      functional: entity.currency,
      rates: options.rates,
      asAt: options.asAt,
      ...(options.period === undefined ? {} : { period: options.period }),
      ...(options.averageMethod === undefined ? {} : { averageMethod: options.averageMethod }),
      ...(options.equityBasis === undefined ? {} : { equityBasis: options.equityBasis }),
      ...(options.historicalAccounts === undefined
        ? {}
        : { historicalAccounts: options.historicalAccounts }),
      ...(options.includeZero === undefined ? {} : { includeZero: options.includeZero }),
      rounding,
    });

    contributions.push(
      Object.freeze({
        entity: entity.code,
        functional: entity.currency,
        translation,
        translationAdjustment: translation.translationAdjustment,
        control,
        windowApplied,
        preAcquisitionResult,
      }),
    );

    for (const row of translation.rows) {
      if (!totals.has(row.account)) {
        totals.set(row.account, Money.zero(presentation));
        byEntity.set(row.account, new Map());
        meta.set(row.account, { name: row.name, type: row.type });
        names.set(row.account, new Map());
        order.push(row.account);
      }
      totals.set(row.account, (totals.get(row.account) as Money).plus(row.presentation));
      (byEntity.get(row.account) as Map<string, Money>).set(entity.code, row.presentation);
      (names.get(row.account) as Map<string, string>).set(entity.code, row.name);
      // A code with a type in one chart and none in another takes the type.
      const known = meta.get(row.account) as { name: string; type: AccountType | null };
      if (known.type === null && row.type !== null) {
        meta.set(row.account, { name: known.name, type: row.type });
      }
    }
  }

  order.sort((a, b) => a.localeCompare(b));

  const rows: CombinedRow[] = order.map((account) => {
    const info = meta.get(account) as { name: string; type: AccountType | null };
    return Object.freeze({
      account,
      name: info.name,
      type: info.type,
      total: totals.get(account) as Money,
      byEntity: Object.freeze(new Map(byEntity.get(account))),
    });
  });

  const nameConflicts: NameConflict[] = [];
  for (const account of order) {
    const perEntity = names.get(account) as Map<string, string>;
    const distinct = new Set(perEntity.values());
    if (distinct.size > 1) {
      nameConflicts.push(
        Object.freeze({
          account,
          names: Object.freeze(
            [...perEntity.entries()].map(([entity, name]) => Object.freeze({ entity, name })),
          ),
        }),
      );
    }
  }

  const translationAdjustment = sumMoney(
    contributions.map((c) => c.translationAdjustment),
    presentation,
  );

  const totalDebit = sumMoney(
    rows.filter((r) => r.total.isPositive).map((r) => r.total),
    presentation,
  ).plus(
    translationAdjustment.isPositive ? translationAdjustment : Money.zero(presentation),
  );
  const totalCredit = sumMoney(
    rows.filter((r) => r.total.isNegative).map((r) => r.total.negated()),
    presentation,
  ).plus(
    translationAdjustment.isNegative ? translationAdjustment.negated() : Money.zero(presentation),
  );

  const excluded = group
    .list()
    .filter((e) => !e.controlled)
    .map((e) =>
      Object.freeze({
        entity: e.code,
        reason: e.controlAsserted
          ? "control is denied by the group's own definition"
          : `held ${e.effective.toPercentString(4)} and not controlled`,
      }),
    );

  const period =
    options.period ?? contributions[0]?.translation.period ?? { from: asAt, to: asAt };

  return Object.freeze({
    presentation,
    asAt,
    period,
    entities: Object.freeze(contributions),
    rows: Object.freeze(rows),
    translationAdjustment,
    totalDebit,
    totalCredit,
    balanced: totalDebit.equals(totalCredit),
    excluded: Object.freeze(excluded),
    nameConflicts: Object.freeze(nameConflicts),
  });
}

/** A row's contribution from one entity, or zero. */
export function contribution(row: CombinedRow, entity: string): Money {
  return row.byEntity.get(entity) ?? Money.zero(row.total.currency);
}

export function renderAggregation(result: Aggregation): string {
  const entities = result.entities.map((c) => c.entity);
  const width = Math.max(22, ...result.rows.map((r) => r.name.length));
  const column = 14;
  const lines: string[] = [];
  lines.push(
    `Combined trial balance as at ${result.asAt} (${result.presentation.code}), ` +
      `${entities.length} ${entities.length === 1 ? "entity" : "entities"}`,
  );
  lines.push(
    "Nothing is eliminated here: every controlled entity is added in full, " +
      "including the part of it held outside the group.",
  );
  lines.push("-".repeat(10 + width + column * (entities.length + 1)));
  lines.push(
    "Account".padEnd(10) +
      "Name".padEnd(width + 2) +
      entities.map((e) => e.padStart(column)).join("") +
      "Combined".padStart(column),
  );
  for (const row of result.rows) {
    lines.push(
      row.account.padEnd(10) +
        row.name.padEnd(width + 2) +
        entities
          .map((e) => {
            const amount = row.byEntity.get(e);
            return (amount === undefined || amount.isZero ? "" : amount.toDecimalString()).padStart(
              column,
            );
          })
          .join("") +
        row.total.toDecimalString().padStart(column),
    );
  }
  if (!result.translationAdjustment.isZero) {
    lines.push(
      "".padEnd(10) +
        "Translation reserve".padEnd(width + 2) +
        result.entities
          .map((c) =>
            (c.translationAdjustment.isZero ? "" : c.translationAdjustment.toDecimalString()).padStart(
              column,
            ),
          )
          .join("") +
        result.translationAdjustment.toDecimalString().padStart(column),
    );
  }
  lines.push("-".repeat(10 + width + column * (entities.length + 1)));
  lines.push(
    "".padEnd(10) +
      "Debit / credit".padEnd(width + 2) +
      "".padEnd(column * entities.length) +
      `${result.totalDebit.toDecimalString()} / ${result.totalCredit.toDecimalString()}`.padStart(
        column,
      ),
  );
  if (!result.balanced) {
    lines.push(`OUT BY ${result.totalDebit.minus(result.totalCredit).toDecimalString()}`);
  }
  for (const skipped of result.excluded) {
    lines.push(`Not consolidated: ${skipped.entity} — ${skipped.reason}`);
  }
  for (const conflict of result.nameConflicts) {
    lines.push(
      `Account ${conflict.account} is named differently in different books: ` +
        conflict.names.map((n) => `${n.entity} "${n.name}"`).join(", "),
    );
  }
  return lines.join("\n");
}
