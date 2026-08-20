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
 */

import type { CalendarDate, DateRange } from "../ledger/date.js";
import { addDays, compareDates, dateRange, maxDate } from "../ledger/date.js";
import type { Entity, GroupStructure } from "./structure.js";

export interface ControlWindow {
  readonly entity: string;
  /** The reporting period, for reference. */
  readonly period: DateRange;
  /** The part of it the group controlled the entity for. Null when none of it. */
  readonly window: DateRange | null;
  /** The day control was obtained, where the books record one. */
  readonly acquired: CalendarDate | null;
  /** True when the entity was the group's for the whole reporting period. */
  readonly whole: boolean;
  /** True when control was obtained inside the reporting period. */
  readonly acquiredDuring: boolean;
  /**
   * The date to close the entity's books at, so that what is left on the
   * income accounts is the group's result. Null where nothing needs closing.
   */
  readonly closeAt: CalendarDate | null;
  /** Why the window is what it is, in words a reader can check. */
  readonly reason: string;
}

/** Where an entity sits in the reporting period. */
export function controlWindow(entity: Entity, period: DateRange): ControlWindow {
  const base = {
    entity: entity.code,
    period,
    acquired: entity.acquired,
  };
  if (entity.acquired === null) {
    return Object.freeze({
      ...base,
      window: period,
      whole: true,
      acquiredDuring: false,
      closeAt: null,
      reason: "no acquisition date, so the whole period is taken to be the group's",
    });
  }
  if (compareDates(entity.acquired, period.from) === -1) {
    return Object.freeze({
      ...base,
      window: period,
      whole: true,
      acquiredDuring: false,
      closeAt: null,
      reason: `acquired ${entity.acquired}, before the period opened`,
    });
  }
  if (compareDates(entity.acquired, period.to) === 1) {
    return Object.freeze({
      ...base,
      window: null,
      whole: false,
      acquiredDuring: false,
      closeAt: null,
      reason: `acquired ${entity.acquired}, after the reporting date`,
    });
  }
  // Control obtained on or inside the period. Everything to and including that
  // day is the seller's; the window opens the day after.
  const opens = maxDate(addDays(entity.acquired, 1), period.from);
  if (compareDates(opens, period.to) === 1) {
    // Control obtained on the reporting date itself. The group owns the
    // balance sheet and none of the period's result, which is a window with
    // no days in it rather than no window at all — the books still need
    // closing, and the entity is still consolidated.
    return Object.freeze({
      ...base,
      window: null,
      whole: false,
      acquiredDuring: true,
      closeAt: entity.acquired,
      reason:
        `acquired ${entity.acquired}, the reporting date, so none of the period's ` +
        `result is the group's`,
    });
  }
  return Object.freeze({
    ...base,
    window: dateRange(String(opens), String(period.to)),
    whole: false,
    acquiredDuring: true,
    closeAt: entity.acquired,
    reason: `acquired ${entity.acquired}, part-way through the period`,
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
  }
  return lines.join("\n");
}
