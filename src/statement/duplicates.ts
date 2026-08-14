/**
 * Duplicate detection on import.
 *
 * The naive rule — same date, same amount, same description means duplicate —
 * is wrong, and wrong in a way that loses money. Two £2.85 coffees from the
 * same shop on the same day are two transactions, not one imported twice.
 *
 * So the rule here is about *counts*, not existence: a batch that contains a
 * fingerprint three times is fine if the account already has none of it, and
 * is a duplicate only for the excess over what is already known. Everything is
 * flagged for review rather than dropped, because only the account holder can
 * say whether they bought two coffees.
 */

import { daysBetween } from "../ledger/date.js";
import type { StatementLine } from "./line.js";

export type DuplicateKind =
  /** Same fingerprint as an earlier line in this same import. */
  | "within-batch"
  /** Same fingerprint as a line already imported previously. */
  | "already-imported";

export interface DuplicateFlag {
  readonly line: StatementLine;
  readonly kind: DuplicateKind;
  /** Which occurrence this is, 1-based, counting prior sightings. */
  readonly occurrence: number;
  readonly reason: string;
  /** Lines that share the fingerprint. */
  readonly conflictsWith: readonly StatementLine[];
}

export interface DuplicateReport {
  readonly unique: readonly StatementLine[];
  readonly flagged: readonly DuplicateFlag[];
}

/**
 * Compare a batch against itself and against lines already held.
 *
 * `existing` is the set already imported; its counts are what a new line has
 * to exceed before it is considered a repeat.
 */
export function findDuplicates(
  batch: readonly StatementLine[],
  existing: readonly StatementLine[] = [],
): DuplicateReport {
  const existingByFingerprint = new Map<string, StatementLine[]>();
  for (const line of existing) {
    const bucket = existingByFingerprint.get(line.fingerprint);
    if (bucket === undefined) existingByFingerprint.set(line.fingerprint, [line]);
    else bucket.push(line);
  }

  const seenInBatch = new Map<string, StatementLine[]>();
  const unique: StatementLine[] = [];
  const flagged: DuplicateFlag[] = [];

  for (const line of batch) {
    const priorInBatch = seenInBatch.get(line.fingerprint) ?? [];
    const priorExisting = existingByFingerprint.get(line.fingerprint) ?? [];

    if (priorExisting.length > 0 && priorInBatch.length === 0) {
      flagged.push({
        line,
        kind: "already-imported",
        occurrence: priorExisting.length + 1,
        reason:
          `A line with the same date, amount and description was already imported ` +
          `(${priorExisting.length} time${priorExisting.length === 1 ? "" : "s"})`,
        conflictsWith: Object.freeze([...priorExisting]),
      });
    } else if (priorInBatch.length > 0) {
      flagged.push({
        line,
        kind: "within-batch",
        occurrence: priorInBatch.length + priorExisting.length + 1,
        reason:
          `Row ${line.sourceRow} repeats row ${(priorInBatch[0] as StatementLine).sourceRow} ` +
          `— same date, amount and description`,
        conflictsWith: Object.freeze([...priorInBatch, ...priorExisting]),
      });
    } else {
      unique.push(line);
    }

    seenInBatch.set(line.fingerprint, [...priorInBatch, line]);
  }

  return Object.freeze({
    unique: Object.freeze(unique),
    flagged: Object.freeze(flagged),
  });
}

/**
 * A softer signal: lines that are suspiciously similar without being identical
 * — same amount and description within a few days. Re-submitted payments and
 * accidental double-imports of overlapping date ranges look like this.
 */
export function findNearDuplicates(
  lines: readonly StatementLine[],
  options: { windowDays?: number } = {},
): readonly { a: StatementLine; b: StatementLine; daysApart: number }[] {
  const window = options.windowDays ?? 3;
  const out: { a: StatementLine; b: StatementLine; daysApart: number }[] = [];

  const byKey = new Map<string, StatementLine[]>();
  for (const line of lines) {
    const key = `${line.amount.currency.code}|${line.amount.minorUnits}|${line.normalisedDescription}`;
    const bucket = byKey.get(key);
    if (bucket === undefined) byKey.set(key, [line]);
    else bucket.push(line);
  }

  for (const bucket of byKey.values()) {
    if (bucket.length < 2) continue;
    const sorted = [...bucket].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (let i = 0; i < sorted.length - 1; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i] as StatementLine;
        const b = sorted[j] as StatementLine;
        const daysApart = Math.abs(daysBetween(a.date, b.date));
        if (daysApart === 0) continue; // exact duplicates are the other function's job
        if (daysApart > window) break;
        out.push({ a, b, daysApart });
      }
    }
  }

  return Object.freeze(out);
}
