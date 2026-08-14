/**
 * The CSV import pipeline.
 *
 * One malformed row must not lose the other four hundred. Every row is
 * attempted independently and failures are collected as data, so the caller
 * gets the lines that worked plus a precise account of what did not and why.
 * An import that half-succeeds and says so is worth far more than one that
 * throws on row 137.
 */

import { Money } from "../money/money.js";
import type { Currency } from "../money/currency.js";
import { currency as lookupCurrency } from "../money/currency.js";
import type { CalendarDate } from "../ledger/date.js";
import {
  type ParseAmountOptions,
  combineDebitCredit,
  detectDecimalConvention,
  parseAmount,
} from "./amount.js";
import { type ColumnMapping, type ColumnRole, inferColumns } from "./columns.js";
import { type Delimiter, readTable } from "./csv.js";
import { type DateFormat, detectDateFormat, parseDateIn } from "./dates.js";
import { type DuplicateFlag, findDuplicates } from "./duplicates.js";
import { type StatementLine, statementLine } from "./line.js";

export interface RowError {
  /** Zero-based index within the data rows, excluding the header. */
  readonly row: number;
  readonly reason: string;
  readonly cells: readonly string[];
}

export interface ImportOptions {
  currency?: Currency | string;
  delimiter?: Delimiter;
  dateFormat?: DateFormat;
  decimal?: "dot" | "comma";
  /** Force a column assignment when inference gets it wrong. */
  columns?: Partial<Record<Exclude<ColumnRole, "unknown">, number>>;
  /** Lines already imported, for duplicate detection. */
  existing?: readonly StatementLine[];
  /** Prefix for generated line ids. */
  idPrefix?: string;
  /** Accept amounts with more precision than the currency holds. */
  rounding?: ParseAmountOptions["rounding"];
}

export interface ImportResult {
  readonly lines: readonly StatementLine[];
  readonly duplicates: readonly DuplicateFlag[];
  readonly errors: readonly RowError[];
  readonly warnings: readonly string[];
  readonly mapping: ColumnMapping;
  readonly delimiter: Delimiter;
  readonly dateFormat: DateFormat;
  readonly decimal: "dot" | "comma";
  readonly currency: Currency;
  readonly rowsRead: number;
}

function columnValue(row: readonly string[], index: number | null): string {
  if (index === null) return "";
  return row[index] ?? "";
}

/** Parse a bank CSV into statement lines. */
export function importCsv(input: string, options: ImportOptions = {}): ImportResult {
  const table = readTable(input, options.delimiter === undefined ? {} : { delimiter: options.delimiter });
  const mapping = inferColumns(table.header, table.rows, options.columns ?? {});
  const warnings: string[] = [...mapping.warnings];
  const errors: RowError[] = [];

  const currency =
    typeof options.currency === "string"
      ? lookupCurrency(options.currency)
      : (options.currency ?? lookupCurrency("GBP"));

  // Decide the date format and decimal convention from whole columns before
  // touching any individual row.
  const dateSamples = table.rows.map((r) => columnValue(r, mapping.date)).filter((v) => v !== "");
  const dateDetection = detectDateFormat(
    dateSamples,
    options.dateFormat === undefined ? {} : { prefer: options.dateFormat },
  );
  if (!dateDetection.confident && dateSamples.length > 0) {
    if (dateDetection.candidates.length > 1) {
      warnings.push(
        `Date column is ambiguous between ${dateDetection.candidates.join(" and ")}; ` +
          `reading it as ${dateDetection.format}. Pass dateFormat to be sure.`,
      );
    } else if (dateDetection.candidates.length === 0) {
      warnings.push(
        `No date format reads every value in the date column` +
          (dateDetection.unparsed.length > 0
            ? ` (for example ${JSON.stringify(dateDetection.unparsed[0])})`
            : ""),
      );
    }
  }

  const amountColumns = [mapping.amount, mapping.debit, mapping.credit].filter(
    (i): i is number => i !== null,
  );
  const amountSamples = table.rows.flatMap((r) =>
    amountColumns.map((i) => r[i] ?? "").filter((v) => v.trim() !== ""),
  );
  const decimalDetection = detectDecimalConvention(amountSamples);
  const decimal = options.decimal ?? decimalDetection.convention;
  if (options.decimal === undefined && !decimalDetection.confident && amountSamples.length > 0) {
    warnings.push(
      `Could not tell whether amounts use '.' or ',' as the decimal separator; ` +
        `assuming '${decimal === "dot" ? "." : ","}'.`,
    );
  }

  const amountOptions: ParseAmountOptions = {
    convention: decimal,
    ...(options.rounding === undefined ? {} : { rounding: options.rounding }),
  };

  const prefix = options.idPrefix ?? "SL";
  const parsed: StatementLine[] = [];

  table.rows.forEach((row, index) => {
    const rawDate = columnValue(row, mapping.date).trim();
    if (rawDate === "") {
      errors.push({ row: index, reason: "no date", cells: [...row] });
      return;
    }

    let when: CalendarDate;
    try {
      when = parseDateIn(rawDate, dateDetection.format);
    } catch {
      errors.push({
        row: index,
        reason: `date ${JSON.stringify(rawDate)} is not ${dateDetection.format}`,
        cells: [...row],
      });
      return;
    }

    let amount: Money;
    try {
      if (mapping.amount !== null) {
        const rawAmount = columnValue(row, mapping.amount).trim();
        if (rawAmount === "") throw new Error("amount cell is empty");
        amount = parseAmount(rawAmount, currency, amountOptions);
      } else if (mapping.debit !== null && mapping.credit !== null) {
        amount = combineDebitCredit(
          columnValue(row, mapping.debit),
          columnValue(row, mapping.credit),
          currency,
          amountOptions,
        );
      } else {
        throw new Error("no amount, debit or credit column");
      }
    } catch (error) {
      errors.push({
        row: index,
        reason: error instanceof Error ? error.message : String(error),
        cells: [...row],
      });
      return;
    }

    let balance: Money | undefined;
    if (mapping.balance !== null) {
      const rawBalance = columnValue(row, mapping.balance).trim();
      if (rawBalance !== "") {
        try {
          balance = parseAmount(rawBalance, currency, amountOptions);
        } catch {
          // A bad balance is not worth losing the transaction over; it is
          // informational, and its absence is noted rather than fatal.
          warnings.push(`Row ${index}: could not read the balance ${JSON.stringify(rawBalance)}`);
        }
      }
    }

    let valueDate: CalendarDate | undefined;
    if (mapping.valueDate !== null) {
      const rawValueDate = columnValue(row, mapping.valueDate).trim();
      if (rawValueDate !== "") {
        try {
          valueDate = parseDateIn(rawValueDate, dateDetection.format);
        } catch {
          warnings.push(`Row ${index}: could not read the value date`);
        }
      }
    }

    const raw: Record<string, string> = {};
    table.header.forEach((name, i) => {
      if (name !== "") raw[name] = row[i] ?? "";
    });

    const description = columnValue(row, mapping.description).trim();
    const reference = columnValue(row, mapping.reference).trim();
    const type = columnValue(row, mapping.type).trim();

    parsed.push(
      statementLine({
        id: `${prefix}-${String(index + 1).padStart(4, "0")}`,
        date: when,
        ...(valueDate === undefined ? {} : { valueDate }),
        description,
        amount,
        ...(balance === undefined ? {} : { balance }),
        ...(reference === "" ? {} : { reference }),
        ...(type === "" ? {} : { type }),
        sourceRow: index,
        raw,
      }),
    );
  });

  const { unique, flagged } = findDuplicates(parsed, options.existing ?? []);

  return Object.freeze({
    lines: Object.freeze(unique),
    duplicates: Object.freeze(flagged),
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
    mapping,
    delimiter: table.delimiter,
    dateFormat: dateDetection.format,
    decimal,
    currency,
    rowsRead: table.rows.length,
  });
}

/** A one-line summary of how an import went, for the CLI and for logs. */
export function describeImport(result: ImportResult): string {
  const parts = [
    `${result.lines.length} line${result.lines.length === 1 ? "" : "s"}`,
    `${result.duplicates.length} duplicate${result.duplicates.length === 1 ? "" : "s"}`,
    `${result.errors.length} error${result.errors.length === 1 ? "" : "s"}`,
  ];
  return `${parts.join(", ")} from ${result.rowsRead} rows (${result.dateFormat}, '${
    result.decimal === "dot" ? "." : ","
  }' decimal, ${result.currency.code})`;
}
