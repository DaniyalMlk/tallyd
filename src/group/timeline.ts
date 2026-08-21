/**
 * How much of the period an entity was the group's.
 *
 * Consolidation has been answering a question about one date, and where the
 * period appeared at all it was only to pick an average rate. That works while
 * every entity was in the group for the whole of it. As soon as one was not,
 * two figures have to be separated that the reporting date alone cannot
 * separate: what the entity earned before anybody in the group controlled it,
 * and what it earned afterwards.
 *
 * The first belongs to the equity that gets eliminated against the investment —
 * it is pre-acquisition, the seller's, and the group paid a price that already
 * reflected it. The second is the group's result, and a share of it belongs to
 * the shareholders outside. Adding all twelve months to the consolidated income
 * statement gets both wrong at once: the group reports revenue it did not earn,
 * and it hands the outside stake a share of a profit earned before the stake
 * existed.
 *
 * A control window is the intersection of the reporting period with the time
 * the entity was controlled. Three cases come out of it:
 *
 * - **The whole period.** Acquired before it started, or long enough ago that
 *   the acquisition date does not fall inside it. Nothing to do.
 * - **Part of it.** Acquired during. The window opens on the day after control
 *   was obtained and the books are closed at the acquisition date, so that
 *   everything up to and including that day is reserves and everything after it
 *   is the group's result.
 * - **None of it.** Two quite different cases that both come out as no window.
 *   Acquired *on* the reporting date: the group owns the balance sheet and none
 *   of the period's result, which is a real and consolidatable position.
 *   Acquired *after* it: not something a consolidation as at that date should be
 *   doing at all, and refused rather than silently treated as a full period.
 *   `acquiredDuring` is what tells the two apart.
 *
 * The boundary is worth stating because it is arbitrary and has to be
 * consistent: net assets at acquisition are measured *as at* the acquisition
 * date, which includes that day's transactions, so the profit up to and
 * including that day must be pre-acquisition too. Otherwise a sale made on the
 * day of completion would be counted in the price paid and in the group's
 * result.
 *
 * The window has a far end too, and it is the harder one. A company sold in
 * September was the group's for eight months and is not the group's on the
 * reporting date, so it contributes eight months of results and no balance
 * sheet at all. Closing its books cannot express that: closing changes which
 * period a result belongs to and leaves the balance sheet exactly where it
 * was. What is needed instead is a second date — the date the entity's own
 * position is read at — so that everything about it is measured on the day
 * control was lost and then taken back out in one balanced step.
 *
 * So a window carries `consolidateAt` beside `closeAt`. For a company held
 * throughout they are the reporting date and nothing; for a company bought in
 * April they are the reporting date and 1 April; for a company sold in
 * September they are 30 September and nothing. For one bought in April and
 * sold in September they are both, and the window is the five months between.
 *
 * The near boundary excludes the acquisition date and the far boundary
 * includes the disposal date, which looks asymmetric and is not: both say that
 * a day's trading belongs to whoever owned the company at the end of it. The
 * seller owns the day the deal completes on the way in, and the group owns the
 * day it completes on the way out, because it is the group's net assets that
 * are being handed over at the price agreed.
 */

import type { CalendarDate, DateRange } from "../ledger/date.js";
import { addDays, compareDates, dateRange, maxDate, minDate } from "../ledger/date.js";
import type { Entity, GroupStructure } from "./structure.js";

export interface ControlWindow {
  readonly entity: string;
  /** The reporting period, for reference. */
  readonly period: DateRange;
  /** The part of it the group controlled the entity for. Null when none of it. */
  readonly window: DateRange | null;
  /** The day control was obtained, where the books record one. */
  readonly acquired: CalendarDate | null;
  /** The day control was lost, where the group has parted with the company. */
  readonly disposed: CalendarDate | null;
  /** True when the entity was the group's for the whole reporting period. */
  readonly whole: boolean;
  /** True when control was obtained inside the reporting period. */
  readonly acquiredDuring: boolean;
  /** True when control was lost on or inside the reporting period. */
  readonly disposedDuring: boolean;
  /**
   * Whether this period's accounts have anything to say about the entity at
   * all. False for a company bought after the reporting date and for one sold
   * before the period opened: in neither case was it the group's for a single
   * day of the period, and in neither case does it have a balance sheet the
   * group can claim.
   */
  readonly inPeriod: boolean;
  /**
   * The date to close the entity's books at, so that what is left on the
   * income accounts is the group's result. Null where nothing needs closing.
   */
  readonly closeAt: CalendarDate | null;
  /**
   * The date the entity's own position is read at. The reporting date for a
   * company still in the group, and the date control was lost for one that is
   * not — because the balance sheet the group has to account for is the one it
   * handed over, not whatever the company has since become.
   */
  readonly consolidateAt: CalendarDate;
  /** Why the window is what it is, in words a reader can check. */
  readonly reason: string;
}

/** Where an entity sits in the reporting period. */
export function controlWindow(entity: Entity, period: DateRange): ControlWindow {
  const base = {
    entity: entity.code,
    period,
    acquired: entity.acquired,
    disposed: entity.disposed,
  };
  const outside = {
    ...base,
    window: null,
    whole: false,
    acquiredDuring: false,
    disposedDuring: false,
    inPeriod: false,
    closeAt: null,
    consolidateAt: period.to,
  };

  // ------------------------------------------------- entirely outside the period
  if (entity.acquired !== null && compareDates(entity.acquired, period.to) === 1) {
    return Object.freeze({
      ...outside,
      reason: `acquired ${entity.acquired}, after the reporting date`,
    });
  }
  if (entity.disposed !== null && compareDates(entity.disposed, period.from) === -1) {
    return Object.freeze({
      ...outside,
      reason: `disposed of ${entity.disposed}, before the period opened`,
    });
  }

  // --------------------------------------------------------------- the two ends
  // The near end excludes the acquisition date: everything to and including the
  // day the deal completed is the seller's. The far end includes the disposal
  // date, for the mirror-image reason.
  const acquiredDuring =
    entity.acquired !== null && compareDates(entity.acquired, period.from) >= 0;
  const disposedDuring =
    entity.disposed !== null && compareDates(entity.disposed, period.to) <= 0;
  const opens = acquiredDuring
    ? maxDate(addDays(entity.acquired as CalendarDate, 1), period.from)
    : period.from;
  const closes = disposedDuring ? minDate(entity.disposed as CalendarDate, period.to) : period.to;

  const consolidateAt = disposedDuring ? closes : period.to;
  const closeAt = acquiredDuring ? (entity.acquired as CalendarDate) : null;
  const shape = {
    ...base,
    acquiredDuring,
    disposedDuring,
    inPeriod: true,
    closeAt,
    consolidateAt,
  };

  if (compareDates(opens, closes) === 1) {
    // No days in the window, which is not the same as no window. Control
    // obtained on the reporting date, or obtained and lost on the same day:
    // either way the group owns a balance sheet and none of the period's
    // result, and the entity is still consolidated.
    return Object.freeze({
      ...shape,
      window: null,
      whole: false,
      reason:
        entity.disposed !== null && entity.acquired !== null
          ? `acquired ${entity.acquired} and disposed of ${entity.disposed}, so no ` +
            `day of the period's result is the group's`
          : `acquired ${entity.acquired}, the reporting date, so none of the period's ` +
            `result is the group's`,
    });
  }

  const window = dateRange(String(opens), String(closes));
  const whole = !acquiredDuring && !disposedDuring;
  return Object.freeze({
    ...shape,
    window,
    whole,
    reason: whole
      ? entity.acquired === null
        ? "no acquisition date, so the whole period is taken to be the group's"
        : `acquired ${entity.acquired}, before the period opened`
      : acquiredDuring && disposedDuring
        ? `acquired ${entity.acquired} and disposed of ${entity.disposed}, both inside the period`
        : acquiredDuring
          ? `acquired ${entity.acquired}, part-way through the period`
          : `disposed of ${entity.disposed}, part-way through the period`,
  });
}

/** Every consolidated entity's window, in the group's order. */
export function controlWindows(
  group: GroupStructure,
  period: DateRange,
): readonly ControlWindow[] {
  return Object.freeze(group.consolidated().map((entity) => controlWindow(entity, period)));
}

export function renderControlWindows(
  windows: readonly ControlWindow[],
  names: (entity: string) => string,
): string {
  const width = Math.max(20, ...windows.map((w) => names(w.entity).length + w.entity.length + 1));
  const lines: string[] = ["How much of the period each company was the group's"];
  for (const window of windows) {
    const span =
      window.window === null
        ? "none of it"
        : window.whole
          ? "the whole period"
          : `${window.window.from} to ${window.window.to}`;
    lines.push(
      `  ${`${window.entity} ${names(window.entity)}`.padEnd(width + 2)}${span.padEnd(26)}${window.reason}`,
    );
    if (window.disposedDuring) {
      lines.push(
        `  ${"".padEnd(width + 2)}${"".padEnd(26)}` +
          `its balance sheet is read at ${window.consolidateAt} and then taken back out`,
      );
    }
  }
  return lines.join("\n");
}
