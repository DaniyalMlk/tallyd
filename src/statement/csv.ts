/**
 * A CSV reader for files exported by banks, which is a narrower and stranger
 * problem than "parse CSV".
 *
 * Real exports arrive with a UTF-8 BOM, CRLF endings, a preamble of two or
 * three junk lines before the header, semicolon delimiters from European
 * banks, and quoted fields containing the delimiter. None of that is exotic;
 * all of it breaks a `line.split(",")`.
 *
 * The tokenizer follows RFC 4180 with one deliberate relaxation: a bare quote
 * inside an unquoted field is treated as data rather than an error, because
 * descriptions like `JOHN'S 24" TV` appear in the wild and rejecting the whole
 * import over one is not a service to anybody.
 */

export const DELIMITERS = [",", ";", "\t", "|"] as const;
export type Delimiter = (typeof DELIMITERS)[number];

export class CsvParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`${message} (line ${line})`);
    this.name = "CsvParseError";
  }
}

/** Strip a UTF-8 byte-order mark, which Excel adds and nothing else wants. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Split into records. Quoted fields may span physical lines, so this cannot be
 * done by splitting on newlines first.
 */
export function parseCsv(input: string, delimiter: Delimiter = ","): string[][] {
  const text = stripBom(input);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldWasQuoted = false;
  let line = 1;
  let sawAnyContent = false;

  const endField = (): void => {
    row.push(fieldWasQuoted ? field : field.trim());
    field = "";
    fieldWasQuoted = false;
  };

  const endRow = (): void => {
    endField();
    // Drop rows that are entirely empty — trailing newlines, blank separators.
    if (row.some((f) => f !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === "\n") line++;
        field += char;
      }
      continue;
    }

    if (char === '"' && field.trim() === "") {
      // A quote only opens a quoted field at the start of one; elsewhere it is
      // literal data.
      inQuotes = true;
      fieldWasQuoted = true;
      field = "";
      sawAnyContent = true;
      continue;
    }

    if (char === delimiter) {
      endField();
      sawAnyContent = true;
      continue;
    }

    if (char === "\r") {
      if (text[i + 1] === "\n") i++;
      line++;
      endRow();
      continue;
    }

    if (char === "\n") {
      line++;
      endRow();
      continue;
    }

    field += char;
    if (char.trim() !== "") sawAnyContent = true;
  }

  if (inQuotes) throw new CsvParseError("Unterminated quoted field", line);
  if (field !== "" || row.length > 0) endRow();
  if (!sawAnyContent) return [];

  return rows;
}

/**
 * Guess the delimiter by looking for the one that gives a consistent column
 * count across the most lines. Counting occurrences on line one alone gets
 * this wrong whenever a description contains a comma.
 */
export function sniffDelimiter(input: string): Delimiter {
  const sample = stripBom(input).split(/\r?\n/).filter((l) => l.trim() !== "").slice(0, 20);
  if (sample.length === 0) return ",";

  let best: Delimiter = ",";
  let bestScore = -1;

  for (const delimiter of DELIMITERS) {
    let rows: string[][];
    try {
      rows = parseCsv(sample.join("\n"), delimiter);
    } catch {
      continue;
    }
    if (rows.length === 0) continue;

    const counts = rows.map((r) => r.length);
    const maxColumns = Math.max(...counts);
    if (maxColumns < 2) continue;

    // Reward consistency and column count; a delimiter that never appears
    // yields one column everywhere and scores zero.
    const modal = mode(counts);
    const consistent = counts.filter((c) => c === modal).length / counts.length;
    const score = consistent * 10 + modal;

    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }

  return best;
}

function mode(values: readonly number[]): number {
  const tally = new Map<number, number>();
  for (const v of values) tally.set(v, (tally.get(v) ?? 0) + 1);
  let best = values[0] ?? 0;
  let bestCount = 0;
  for (const [value, count] of tally) {
    if (count > bestCount || (count === bestCount && value > best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

export interface CsvTable {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly delimiter: Delimiter;
  /** How many leading junk lines were skipped before the header. */
  readonly preambleLines: number;
}

/**
 * Read a table, locating the header row rather than assuming it is first.
 *
 * Banks routinely prefix an export with the account name, the statement period
 * and a blank line. The header is taken to be the first row whose width equals
 * the modal width of the file — a preamble line is almost always narrower.
 */
export function readTable(input: string, options: { delimiter?: Delimiter } = {}): CsvTable {
  const delimiter = options.delimiter ?? sniffDelimiter(input);
  const rows = parseCsv(input, delimiter);
  if (rows.length === 0) {
    return { header: [], rows: [], delimiter, preambleLines: 0 };
  }

  const widths = rows.map((r) => r.length);
  const modal = mode(widths);
  const headerIndex = rows.findIndex((r) => r.length === modal);
  const header = (rows[headerIndex] as readonly string[]).map((h) => h.trim());

  const body = rows.slice(headerIndex + 1).filter((r) => r.some((f) => f.trim() !== ""));

  return {
    header,
    rows: body,
    delimiter,
    preambleLines: headerIndex,
  };
}
