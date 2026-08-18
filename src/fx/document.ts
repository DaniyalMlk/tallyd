/**
 * A rate set on disk.
 *
 * Two readers, because rates arrive in two shapes. The JSON document is the
 * canonical one — versioned, explicit about direction, and carrying the
 * staleness bound the table was built with, so a file says how it expects to
 * be read. The CSV reader exists because what actually comes out of a central
 * bank download is a wide table: one row per date, one column per currency,
 * all quoted against a single base.
 *
 * As with the ledger document, a rate is a decimal string, never a JSON number.
 * `0.8473` parsed as a float is `0.84730000000000005329070518200751394033432`,
 * and it would be embarrassing for a file format to be the one place the
 * engine loses precision.
 */

import { readTable } from "../statement/csv.js";
import { isValidDate } from "../ledger/date.js";
import { isRegistered } from "../money/currency.js";
import { type QuoteInput, RateTable } from "./table.js";

export class RateDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateDocumentError";
  }
}

export interface QuoteDocument {
  readonly date: string;
  readonly base: string;
  readonly quote: string;
  /** Decimal string in the quote currency per one unit of the base. */
  readonly rate: string;
  readonly source?: string;
}

export interface RateDocument {
  readonly version: 1;
  readonly maxStaleDays?: number;
  readonly maxLegs?: number;
  readonly quotes: readonly QuoteDocument[];
}

// --------------------------------------------------------------------- write

export function ratesToDocument(table: RateTable): RateDocument {
  return {
    version: 1,
    maxStaleDays: table.maxStaleDays,
    maxLegs: table.maxLegs,
    quotes: table.all().map((q) => ({
      date: q.date,
      base: q.rate.base.code,
      quote: q.rate.quote.code,
      rate: q.rate.toDecimalString(10),
      ...(q.source === "manual" ? {} : { source: q.source }),
    })),
  };
}

export function ratesToJson(table: RateTable, indent = 2): string {
  return JSON.stringify(ratesToDocument(table), null, indent);
}

// ---------------------------------------------------------------------- read

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new RateDocumentError(`${what} must be a string, got ${typeof value}`);
  }
  return value;
}

function requireCurrency(value: unknown, what: string): string {
  const code = requireString(value, what).toUpperCase();
  if (!isRegistered(code)) {
    throw new RateDocumentError(`${what} names an unknown currency: ${code}`);
  }
  return code;
}

function requireDate(value: unknown, what: string): string {
  const text = requireString(value, what);
  if (!isValidDate(text)) throw new RateDocumentError(`${what} is not a calendar date: ${text}`);
  return text;
}

function optionalCount(value: unknown, what: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RateDocumentError(`${what} must be a non-negative integer`);
  }
  return value;
}

export function ratesFromDocument(document: unknown): RateTable {
  if (typeof document !== "object" || document === null) {
    throw new RateDocumentError("A rate document must be an object");
  }
  const doc = document as Record<string, unknown>;
  if (doc["version"] !== 1) {
    throw new RateDocumentError(`Unsupported rate document version: ${String(doc["version"])}`);
  }
  const raw = doc["quotes"];
  if (!Array.isArray(raw)) throw new RateDocumentError("quotes must be an array");

  const inputs: QuoteInput[] = raw.map((value, index) => {
    if (typeof value !== "object" || value === null) {
      throw new RateDocumentError(`quotes[${index}] must be an object`);
    }
    const q = value as Record<string, unknown>;
    const input: QuoteInput = {
      date: requireDate(q["date"], `quotes[${index}].date`),
      base: requireCurrency(q["base"], `quotes[${index}].base`),
      quote: requireCurrency(q["quote"], `quotes[${index}].quote`),
      rate: requireString(q["rate"], `quotes[${index}].rate`),
    };
    const source = q["source"];
    if (source !== undefined) {
      return { ...input, source: requireString(source, `quotes[${index}].source`) };
    }
    return input;
  });

  const options: { maxStaleDays?: number; maxLegs?: number } = {};
  const stale = optionalCount(doc["maxStaleDays"], "maxStaleDays");
  if (stale !== undefined) options.maxStaleDays = stale;
  const legs = optionalCount(doc["maxLegs"], "maxLegs");
  if (legs !== undefined) options.maxLegs = legs;

  try {
    return RateTable.of(inputs, options);
  } catch (error) {
    throw new RateDocumentError(`Rate document rejected: ${(error as Error).message}`);
  }
}

export function ratesFromJson(text: string): RateTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RateDocumentError(`Rate document is not valid JSON: ${(error as Error).message}`);
  }
  return ratesFromDocument(parsed);
}

// ------------------------------------------------------------------ CSV read

export interface RateCsvOptions {
  /**
   * The base currency every column is quoted against. Inferred from a column
   * header of the form `EUR/USD` when the file names the pair; required when
   * the columns are bare currency codes.
   */
  base?: string;
  source?: string;
  /**
   * Invert every quote on the way in. Some downloads publish "units of base
   * per unit of column" rather than the other way round.
   */
  invert?: boolean;
}

const DATE_HEADERS = new Set(["date", "day", "as at", "as_at", "period", "time"]);

/**
 * Read a wide rate table: one date column, then one column per currency.
 *
 * Headers may be bare codes (`USD`) or explicit pairs (`EUR/USD`). Blank cells
 * are holidays for that currency, not zeroes, and are skipped.
 */
export function ratesFromCsv(text: string, options: RateCsvOptions = {}): RateTable {
  const table = readTable(text);
  if (table.header.length < 2) {
    throw new RateDocumentError("A rate CSV needs a date column and at least one rate column");
  }

  const dateIndex = table.header.findIndex((h) => DATE_HEADERS.has(h.trim().toLowerCase()));
  if (dateIndex === -1) {
    throw new RateDocumentError(
      `No date column found; headers were: ${table.header.join(", ")}`,
    );
  }

  interface Column {
    readonly index: number;
    readonly base: string;
    readonly quote: string;
  }

  const columns: Column[] = [];
  table.header.forEach((header, index) => {
    if (index === dateIndex) return;
    const name = header.trim().toUpperCase();
    if (name === "") return;
    const slash = name.indexOf("/");
    if (slash !== -1) {
      const base = name.slice(0, slash).trim();
      const quote = name.slice(slash + 1).trim();
      if (!isRegistered(base) || !isRegistered(quote)) {
        throw new RateDocumentError(`Column ${header} names an unknown currency`);
      }
      columns.push({ index, base, quote });
      return;
    }
    if (options.base === undefined) {
      throw new RateDocumentError(
        `Column ${header} is a bare currency code, so the file's base currency must be given`,
      );
    }
    const base = options.base.toUpperCase();
    if (!isRegistered(name)) {
      throw new RateDocumentError(`Column ${header} names an unknown currency`);
    }
    if (name === base) return; // a base-against-itself column of 1.0000
    columns.push({ index, base, quote: name });
  });

  if (columns.length === 0) {
    throw new RateDocumentError("A rate CSV needs at least one currency column");
  }

  const inputs: QuoteInput[] = [];
  table.rows.forEach((row, rowIndex) => {
    const dateCell = (row[dateIndex] ?? "").trim();
    if (dateCell === "") return;
    if (!isValidDate(dateCell)) {
      throw new RateDocumentError(`Row ${rowIndex + 1}: ${dateCell} is not a YYYY-MM-DD date`);
    }
    for (const column of columns) {
      const cell = (row[column.index] ?? "").trim();
      if (cell === "" || cell === "-" || cell.toUpperCase() === "N/A") continue;
      const input: QuoteInput = {
        date: dateCell,
        base: options.invert === true ? column.quote : column.base,
        quote: options.invert === true ? column.base : column.quote,
        rate: cell,
        source: options.source ?? "csv",
      };
      inputs.push(input);
    }
  });

  if (inputs.length === 0) throw new RateDocumentError("A rate CSV needs at least one quote");

  try {
    return RateTable.of(inputs);
  } catch (error) {
    throw new RateDocumentError(`Rate CSV rejected: ${(error as Error).message}`);
  }
}

/** Read whichever of the two formats the text looks like. */
export function ratesFromText(text: string, options: RateCsvOptions = {}): RateTable {
  return text.trimStart().startsWith("{") ? ratesFromJson(text) : ratesFromCsv(text, options);
}
