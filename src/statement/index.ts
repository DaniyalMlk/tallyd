export {
  type Delimiter,
  DELIMITERS,
  CsvParseError,
  stripBom,
  parseCsv,
  sniffDelimiter,
  readTable,
  type CsvTable,
} from "./csv.js";

export {
  type DecimalConvention,
  type ParseAmountOptions,
  AmountParseError,
  detectDecimalConvention,
  normaliseAmount,
  parseAmount,
  combineDebitCredit,
  looksLikeAmount,
} from "./amount.js";

export {
  type DateFormat,
  type DateFormatDetection,
  DATE_FORMATS,
  DateParseError,
  parseDateIn,
  canParseIn,
  detectDateFormat,
  parseDateColumn,
  looksLikeDate,
} from "./dates.js";

export {
  type ColumnRole,
  type ColumnAssignment,
  type ColumnMapping,
  inferColumns,
} from "./columns.js";

export {
  type StatementLine,
  type StatementLineInput,
  statementLine,
  normaliseDescription,
  hashString,
  fingerprintOf,
  isMoneyIn,
  isMoneyOut,
} from "./line.js";

export {
  type DuplicateKind,
  type DuplicateFlag,
  type DuplicateReport,
  findDuplicates,
  findNearDuplicates,
} from "./duplicates.js";

export {
  type ImportOptions,
  type ImportResult,
  type RowError,
  importCsv,
  describeImport,
} from "./import.js";

export {
  type OfxAccount,
  type OfxImportOptions,
  type OfxImportResult,
  importOfx,
  parseOfxDate,
  extractTransactionBlocks,
  looksLikeOfx,
} from "./ofx.js";

import { type ImportOptions, type ImportResult, importCsv } from "./import.js";
import { importOfx, looksLikeOfx } from "./ofx.js";
import type { StatementLine } from "./line.js";

/**
 * Import a statement without being told which format it is in. Bank downloads
 * arrive as whatever the bank felt like that day.
 */
export function importStatement(
  input: string,
  options: ImportOptions = {},
): {
  lines: readonly StatementLine[];
  warnings: readonly string[];
  errors: ImportResult["errors"];
  format: "csv" | "ofx";
} {
  if (looksLikeOfx(input)) {
    const result = importOfx(
      input,
      options.currency === undefined ? {} : { currency: options.currency },
    );
    return {
      lines: result.lines,
      warnings: result.warnings,
      errors: result.errors,
      format: "ofx",
    };
  }
  const result = importCsv(input, options);
  return {
    lines: result.lines,
    warnings: result.warnings,
    errors: result.errors,
    format: "csv",
  };
}
