/**
 * Calendar dates as `YYYY-MM-DD` strings.
 *
 * A posting happens on a date, not at an instant. Using `Date` here would drag
 * in a timezone, and a statement line dated 1 March in London would sort before
 * a ledger entry dated 1 March in New York. So: no clocks, no zones, just the
 * proleptic Gregorian calendar and integer day arithmetic.
 */

export type CalendarDate = string & { readonly __brand: "CalendarDate" };

const PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export class InvalidDateError extends Error {
  constructor(value: string) {
    super(`Not a valid calendar date: ${JSON.stringify(value)}`);
    this.name = "InvalidDateError";
  }
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      throw new RangeError(`Month out of range: ${month}`);
  }
}

/** Validate and brand a `YYYY-MM-DD` string. */
export function date(value: string): CalendarDate {
  const match = PATTERN.exec(value);
  if (match === null) throw new InvalidDateError(value);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) throw new InvalidDateError(value);
  if (day < 1 || day > daysInMonth(year, month)) throw new InvalidDateError(value);
  return value as CalendarDate;
}

export function isValidDate(value: string): boolean {
  try {
    date(value);
    return true;
  } catch {
    return false;
  }
}

export function parts(d: CalendarDate): { year: number; month: number; day: number } {
  const match = PATTERN.exec(d) as RegExpExecArray;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

/**
 * Days since 1970-01-01, computed arithmetically (Howard Hinnant's civil-days
 * algorithm) so there is no dependence on the host `Date` implementation.
 */
export function toEpochDay(d: CalendarDate): number {
  const { year, month, day } = parts(d);
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function fromEpochDay(epochDay: number): CalendarDate {
  const z = epochDay + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = month <= 2 ? y + 1 : y;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` as CalendarDate;
}

/** Signed whole days from `a` to `b`. */
export function daysBetween(a: CalendarDate, b: CalendarDate): number {
  return toEpochDay(b) - toEpochDay(a);
}

export function addDays(d: CalendarDate, days: number): CalendarDate {
  return fromEpochDay(toEpochDay(d) + days);
}

export function compareDates(a: CalendarDate, b: CalendarDate): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDate(a: CalendarDate, b: CalendarDate): CalendarDate {
  return a <= b ? a : b;
}

export function maxDate(a: CalendarDate, b: CalendarDate): CalendarDate {
  return a >= b ? a : b;
}

/** 0 = Sunday through 6 = Saturday. */
export function dayOfWeek(d: CalendarDate): number {
  return (((toEpochDay(d) + 4) % 7) + 7) % 7;
}

export function isWeekend(d: CalendarDate): boolean {
  const dow = dayOfWeek(d);
  return dow === 0 || dow === 6;
}

/** First and last day of the month containing `d`. */
export function startOfMonth(d: CalendarDate): CalendarDate {
  const { year, month } = parts(d);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01` as CalendarDate;
}

export function endOfMonth(d: CalendarDate): CalendarDate {
  const { year, month } = parts(d);
  const last = daysInMonth(year, month);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}` as CalendarDate;
}

/** An inclusive date range. */
export interface DateRange {
  readonly from: CalendarDate;
  readonly to: CalendarDate;
}

export function dateRange(from: string, to: string): DateRange {
  const f = date(from);
  const t = date(to);
  if (f > t) throw new RangeError(`Date range is inverted: ${from}..${to}`);
  return Object.freeze({ from: f, to: t });
}

export function withinRange(d: CalendarDate, range: DateRange): boolean {
  return d >= range.from && d <= range.to;
}
