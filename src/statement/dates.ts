/**
 * Reading the date column.
 *
 * `03/04/2026` is the third of April in London and the fourth of March in New
 * York, and a bank export rarely says which it means. Guessing per row is the
 * worst option: it produces a statement where some rows are right and some are
 * silently six weeks out.
 *
 * So the format is decided once for the whole column. A single value with a
 * component above 12 settles it for every other row. Where the column is
 * genuinely ambiguous — every day-of-month is 12 or under — the caller is told
 * so and can insist on a format rather than accept a coin flip.
 */

import { type CalendarDate, date as toCalendarDate, daysInMonth } from "../ledger/date.js";

export type DateFormat =
  | "YYYY-MM-DD"
  | "DD/MM/YYYY"
  | "MM/DD/YYYY"
  | "DD-MM-YYYY"
  | "MM-DD-YYYY"
  | "DD.MM.YYYY"
  | "YYYY/MM/DD"
  | "DD-MMM-YYYY"
  | "MMM DD, YYYY";

export const DATE_FORMATS: readonly DateFormat[] = [
  "YYYY-MM-DD",
  "YYYY/MM/DD",
  "DD/MM/YYYY",
  "MM/DD/YYYY",
  "DD-MM-YYYY",
  "MM-DD-YYYY",
  "DD.MM.YYYY",
  "DD-MMM-YYYY",
  "MMM DD, YYYY",
];

export class DateParseError extends Error {
  constructor(
    readonly input: string,
    readonly format: DateFormat | null,
  ) {
    super(
      format === null
        ? `Cannot read ${JSON.stringify(input)} as a date`
        : `Cannot read ${JSON.stringify(input)} as ${format}`,
    );
    this.name = "DateParseError";
  }
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

interface Components {
  year: number;
  month: number;
  day: number;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** Expand a two-digit year with the usual 1970 pivot. */
function expandYear(year: number): number {
  if (year >= 100) return year;
  return year < 70 ? 2000 + year : 1900 + year;
}

function componentsFor(input: string, format: DateFormat): Components | null {
  const text = input.trim();

  if (format === "DD-MMM-YYYY") {
    const m = /^(\d{1,2})[-\s]([A-Za-z]{3,4})[-\s](\d{2,4})$/.exec(text);
    if (m === null) return null;
    const month = MONTH_NAMES[(m[2] as string).toLowerCase()];
    if (month === undefined) return null;
    return { year: expandYear(Number(m[3])), month, day: Number(m[1]) };
  }

  if (format === "MMM DD, YYYY") {
    const m = /^([A-Za-z]{3,4})\.?\s+(\d{1,2}),?\s+(\d{2,4})$/.exec(text);
    if (m === null) return null;
    const month = MONTH_NAMES[(m[1] as string).toLowerCase()];
    if (month === undefined) return null;
    return { year: expandYear(Number(m[3])), month, day: Number(m[2]) };
  }

  const separator = format.includes("/") ? "/" : format.includes(".") ? "." : "-";
  const parts = text.split(separator);
  if (parts.length !== 3) return null;
  if (parts.some((p) => !/^\d{1,4}$/.test(p.trim()))) return null;

  const [a, b, c] = parts.map((p) => Number(p.trim())) as [number, number, number];

  switch (format) {
    case "YYYY-MM-DD":
    case "YYYY/MM/DD":
      return { year: a, month: b, day: c };
    case "DD/MM/YYYY":
    case "DD-MM-YYYY":
    case "DD.MM.YYYY":
      return { year: expandYear(c), month: b, day: a };
    case "MM/DD/YYYY":
    case "MM-DD-YYYY":
      return { year: expandYear(c), month: a, day: b };
    default:
      return null;
  }
}

function isRealDate(c: Components): boolean {
  if (c.year < 1000 || c.year > 9999) return false;
  if (c.month < 1 || c.month > 12) return false;
  if (c.day < 1 || c.day > daysInMonth(c.year, c.month)) return false;
  return true;
}

/** Parse one value in a known format. */
export function parseDateIn(input: string, format: DateFormat): CalendarDate {
  const components = componentsFor(input, format);
  if (components === null || !isRealDate(components)) {
    throw new DateParseError(input, format);
  }
  return toCalendarDate(
    `${pad(components.year, 4)}-${pad(components.month, 2)}-${pad(components.day, 2)}`,
  );
}

export function canParseIn(input: string, format: DateFormat): boolean {
  const components = componentsFor(input, format);
  return components !== null && isRealDate(components);
}

/**
 * Share of a column a format must read to be considered at all. Below this it
 * is the wrong format rather than the right one with bad rows in it.
 */
const MINIMUM_COVERAGE = 0.8;

export interface DateFormatDetection {
  readonly format: DateFormat;
  /** Every format that parses all the samples. More than one means ambiguity. */
  readonly candidates: readonly DateFormat[];
  /** False when day/month order could not be settled from the data. */
  readonly confident: boolean;
  /** Samples no candidate format could read. */
  readonly unparsed: readonly string[];
}

/**
 * Work out which format a column of dates is in.
 *
 * A format survives only if it reads *every* sample. Where both DD/MM and
 * MM/DD survive, the column contains no value with a component above 12 and
 * the order is genuinely undecidable from the data alone.
 */
export function detectDateFormat(
  samples: readonly string[],
  options: { prefer?: DateFormat } = {},
): DateFormatDetection {
  const usable = samples.map((s) => s.trim()).filter((s) => s !== "");
  if (usable.length === 0) {
    return {
      format: options.prefer ?? "YYYY-MM-DD",
      candidates: [],
      confident: false,
      unparsed: [],
    };
  }

  // A format need not read *every* sample: one impossible value like 31/02
  // should not disqualify the format the other four hundred rows are in. But
  // it must read a strong majority, or it is simply the wrong format.
  const coverage = DATE_FORMATS.map((format) => ({
    format,
    read: usable.filter((sample) => canParseIn(sample, format)).length,
  }));
  const best = Math.max(...coverage.map((c) => c.read));
  const threshold = Math.max(1, Math.ceil(usable.length * MINIMUM_COVERAGE));
  const candidates =
    best >= threshold
      ? coverage.filter((c) => c.read === best).map((c) => c.format)
      : [];

  if (candidates.length === 0) {
    return {
      format: options.prefer ?? "YYYY-MM-DD",
      candidates: [],
      confident: false,
      unparsed: usable.filter((s) => !DATE_FORMATS.some((f) => canParseIn(s, f))),
    };
  }

  const unreadable = usable.filter((s) => !candidates.some((f) => canParseIn(s, f)));

  // Prefer the caller's format when it is still viable — this is how a user
  // resolves an ambiguous column.
  const preferred = options.prefer;
  if (preferred !== undefined && candidates.includes(preferred)) {
    return { format: preferred, candidates, confident: true, unparsed: unreadable };
  }

  // Day-first and month-first both surviving means the data cannot tell them
  // apart; the ordering of DATE_FORMATS then decides, and confidence is false.
  const dayFirst = candidates.filter((f) => f.startsWith("DD"));
  const monthFirst = candidates.filter((f) => f.startsWith("MM"));
  const ambiguous = dayFirst.length > 0 && monthFirst.length > 0;

  return {
    format: candidates[0] as DateFormat,
    candidates,
    confident: !ambiguous,
    unparsed: unreadable,
  };
}

/** Parse a column, detecting the format from the column itself. */
export function parseDateColumn(
  values: readonly string[],
  options: { prefer?: DateFormat } = {},
): { dates: readonly (CalendarDate | null)[]; detection: DateFormatDetection } {
  const detection = detectDateFormat(values, options);
  const dates = values.map((value) => {
    if (value.trim() === "") return null;
    try {
      return parseDateIn(value, detection.format);
    } catch {
      return null;
    }
  });
  return { dates, detection };
}

/** True when a string parses as a date in any supported format. */
export function looksLikeDate(input: string): boolean {
  return DATE_FORMATS.some((format) => canParseIn(input, format));
}
