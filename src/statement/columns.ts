/**
 * Working out which column is which.
 *
 * Header names are a hint, not an answer: banks ship `Transaction Date`,
 * `Datum`, `Post Date`, `Value Date` and sometimes nothing at all. So each
 * column is scored twice — once on its name, once on what its cells actually
 * look like — and the content score is what saves an unlabelled export.
 */

import { looksLikeAmount } from "./amount.js";
import { looksLikeDate } from "./dates.js";

export type ColumnRole =
  | "date"
  | "valueDate"
  | "description"
  | "amount"
  | "debit"
  | "credit"
  | "balance"
  | "reference"
  | "currency"
  | "type"
  | "unknown";

/** Header aliases, lowercased. Longer, more specific names come first. */
const NAME_HINTS: Array<{ role: ColumnRole; patterns: RegExp[]; weight: number }> = [
  {
    role: "valueDate",
    patterns: [/^value\s*date$/, /^val\s*date$/, /^settle(ment)?\s*date$/, /^valuta/],
    weight: 10,
  },
  {
    role: "date",
    patterns: [
      /^(transaction|posting|post|booking|entry|trans)\s*date$/,
      /^date$/,
      /^datum$/,
      /^fecha$/,
      /^date\s*of\s*transaction$/,
    ],
    weight: 10,
  },
  {
    role: "debit",
    patterns: [/^debit/, /^paid\s*out$/, /^money\s*out$/, /^withdrawal/, /^afschrijving/, /^soll$/],
    weight: 10,
  },
  {
    role: "credit",
    patterns: [/^credit/, /^paid\s*in$/, /^money\s*in$/, /^deposit/, /^bijschrijving/, /^haben$/],
    weight: 10,
  },
  {
    role: "balance",
    patterns: [/balance/, /^saldo$/, /^running\s*total$/],
    weight: 10,
  },
  {
    role: "amount",
    patterns: [/^amount$/, /^value$/, /^bedrag$/, /^betrag$/, /^importe$/, /amount/],
    weight: 8,
  },
  {
    role: "description",
    patterns: [
      /^description$/,
      /^narrative$/,
      /^details?$/,
      /^payee$/,
      /^memo$/,
      /^particulars$/,
      /^omschrijving$/,
      /^merchant$/,
      /description|narrative|details/,
    ],
    weight: 8,
  },
  {
    role: "reference",
    patterns: [/^reference$/, /^ref$/, /^transaction\s*id$/, /^cheque\s*(no|number)$/, /ref/],
    weight: 7,
  },
  {
    role: "currency",
    patterns: [/^currency$/, /^ccy$/, /^valuta\s*code$/],
    weight: 9,
  },
  {
    role: "type",
    patterns: [/^type$/, /^transaction\s*type$/, /^tx\s*type$/, /^code$/],
    weight: 7,
  },
];

function nameScore(header: string, role: ColumnRole): number {
  const name = header.trim().toLowerCase().replace(/[_.]/g, " ").replace(/\s+/g, " ");
  if (name === "") return 0;
  for (const hint of NAME_HINTS) {
    if (hint.role !== role) continue;
    for (let i = 0; i < hint.patterns.length; i++) {
      const pattern = hint.patterns[i] as RegExp;
      if (pattern.test(name)) {
        // Earlier patterns are the more exact ones.
        return hint.weight - i * 0.1;
      }
    }
  }
  return 0;
}

function fraction(values: readonly string[], predicate: (v: string) => boolean): number {
  const nonEmpty = values.filter((v) => v.trim() !== "");
  if (nonEmpty.length === 0) return 0;
  return nonEmpty.filter(predicate).length / nonEmpty.length;
}

function contentScore(values: readonly string[], role: ColumnRole): number {
  switch (role) {
    case "date":
    case "valueDate":
      return fraction(values, looksLikeDate) * 8;
    case "amount":
    case "debit":
    case "credit":
    case "balance": {
      const numeric = fraction(values, looksLikeAmount);
      const dateish = fraction(values, looksLikeDate);
      return Math.max(0, numeric - dateish) * 6;
    }
    case "description": {
      const wordy = fraction(
        values,
        (v) => !looksLikeAmount(v) && !looksLikeDate(v) && v.trim().length >= 3,
      );
      return wordy * 5;
    }
    case "currency":
      return fraction(values, (v) => /^[A-Za-z]{3}$/.test(v.trim())) * 6;
    default:
      return 0;
  }
}

export interface ColumnAssignment {
  readonly index: number;
  readonly header: string;
  readonly role: ColumnRole;
  readonly score: number;
}

export interface ColumnMapping {
  readonly assignments: readonly ColumnAssignment[];
  readonly date: number | null;
  readonly valueDate: number | null;
  readonly description: number | null;
  readonly amount: number | null;
  readonly debit: number | null;
  readonly credit: number | null;
  readonly balance: number | null;
  readonly reference: number | null;
  readonly currency: number | null;
  readonly type: number | null;
  readonly warnings: readonly string[];
}

/** Roles at most one column may hold. */
const EXCLUSIVE: readonly ColumnRole[] = [
  "date",
  "valueDate",
  "description",
  "amount",
  "debit",
  "credit",
  "balance",
  "reference",
  "currency",
  "type",
];

/**
 * Assign roles to columns.
 *
 * Greedy over the highest-scoring (column, role) pairs: each column takes one
 * role and each role one column. Greedy is enough here because the scores are
 * well separated in practice, and it is explainable — every assignment carries
 * the score that won it, which matters when a user asks why their file was
 * read the way it was.
 */
export function inferColumns(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  overrides: Partial<Record<Exclude<ColumnRole, "unknown">, number>> = {},
): ColumnMapping {
  const columnCount = Math.max(header.length, ...rows.map((r) => r.length), 0);
  const columns: string[][] = [];
  for (let i = 0; i < columnCount; i++) {
    columns.push(rows.map((r) => r[i] ?? ""));
  }

  const scored: Array<{ index: number; role: ColumnRole; score: number }> = [];
  for (let index = 0; index < columnCount; index++) {
    const name = header[index] ?? "";
    const values = columns[index] as string[];
    for (const role of EXCLUSIVE) {
      const score = nameScore(name, role) + contentScore(values, role);
      if (score > 0) scored.push({ index, role, score });
    }
  }

  scored.sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score));

  const roleToColumn = new Map<ColumnRole, number>();
  const columnToRole = new Map<number, ColumnRole>();
  const scoreByColumn = new Map<number, number>();

  for (const [role, index] of Object.entries(overrides) as Array<[ColumnRole, number]>) {
    roleToColumn.set(role, index);
    columnToRole.set(index, role);
    scoreByColumn.set(index, Number.POSITIVE_INFINITY);
  }

  for (const candidate of scored) {
    if (roleToColumn.has(candidate.role)) continue;
    if (columnToRole.has(candidate.index)) continue;
    roleToColumn.set(candidate.role, candidate.index);
    columnToRole.set(candidate.index, candidate.role);
    scoreByColumn.set(candidate.index, candidate.score);
  }

  const assignments: ColumnAssignment[] = [];
  for (let index = 0; index < columnCount; index++) {
    assignments.push(
      Object.freeze({
        index,
        header: header[index] ?? "",
        role: columnToRole.get(index) ?? "unknown",
        score: scoreByColumn.get(index) ?? 0,
      }),
    );
  }

  const at = (role: ColumnRole): number | null => roleToColumn.get(role) ?? null;

  const warnings: string[] = [];
  const amount = at("amount");
  const debit = at("debit");
  const credit = at("credit");

  if (amount === null && (debit === null || credit === null)) {
    warnings.push(
      "No amount column found, and no debit/credit pair either — rows cannot be valued",
    );
  }
  if (amount !== null && debit !== null && credit !== null) {
    warnings.push(
      "Found both an amount column and a debit/credit pair; the amount column wins",
    );
  }
  if (at("date") === null) warnings.push("No date column found");
  if (at("description") === null) {
    warnings.push("No description column found; matching will rely on amount and date alone");
  }

  return Object.freeze({
    assignments: Object.freeze(assignments),
    date: at("date"),
    valueDate: at("valueDate"),
    description: at("description"),
    amount,
    debit,
    credit,
    balance: at("balance"),
    reference: at("reference"),
    currency: at("currency"),
    type: at("type"),
    warnings: Object.freeze(warnings),
  });
}
