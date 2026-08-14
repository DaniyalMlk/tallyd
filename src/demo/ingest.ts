/**
 * Renders what the importer made of the demo bank statement. Run with:
 *
 *     npm run demo:ingest
 */

import { describeImport, importCsv } from "../statement/import.js";
import { findNearDuplicates } from "../statement/duplicates.js";
import { importOfx } from "../statement/ofx.js";
import { GBP } from "../money/currency.js";
import { DEMO_BANK_CSV, DEMO_BANK_OFX } from "./statement.js";

export function ingestReport(): string {
  const lines: string[] = [];

  const csv = importCsv(DEMO_BANK_CSV, { currency: GBP, idPrefix: "BANK" });

  lines.push("Bank statement — CSV");
  lines.push(`  ${describeImport(csv)}`);
  lines.push(
    `  columns: ${csv.mapping.assignments
      .filter((a) => a.role !== "unknown")
      .map((a) => `${a.index}:${a.role}`)
      .join("  ")}`,
  );
  lines.push("");

  lines.push(`  ${"Date".padEnd(12)}${"Description".padEnd(34)}${"Amount".padStart(11)}`);
  for (const line of csv.lines) {
    lines.push(
      `  ${line.date.padEnd(12)}${line.description.slice(0, 32).padEnd(34)}` +
        `${line.amount.toDecimalString().padStart(11)}`,
    );
  }
  lines.push("");

  if (csv.duplicates.length > 0) {
    lines.push("Flagged as duplicates (not dropped — a human decides)");
    for (const flag of csv.duplicates) {
      lines.push(
        `  row ${flag.line.sourceRow}  ${flag.line.date}  ` +
          `${flag.line.amount.toDecimalString().padStart(10)}  ${flag.reason}`,
      );
    }
    lines.push("");
  }

  const near = findNearDuplicates([...csv.lines, ...csv.duplicates.map((d) => d.line)]);
  if (near.length > 0) {
    lines.push("Near-duplicates worth a second look");
    for (const pair of near) {
      lines.push(
        `  ${pair.a.date} and ${pair.b.date} (${pair.daysApart}d apart): ` +
          `${pair.a.amount.toDecimalString()} ${pair.a.normalisedDescription}`,
      );
    }
    lines.push("");
  }

  if (csv.warnings.length > 0) {
    lines.push("Warnings");
    for (const warning of csv.warnings) lines.push(`  ${warning}`);
    lines.push("");
  }

  const ofx = importOfx(DEMO_BANK_OFX);
  lines.push("Same account — OFX download");
  lines.push(
    `  ${ofx.lines.length} transactions, ${ofx.errors.length} errors, ` +
      `closing balance ${ofx.ledgerBalance?.format() ?? "unknown"} as at ${ofx.balanceAsOf ?? "?"}`,
  );
  lines.push(
    `  account ${ofx.account.bankId ?? "?"}/${ofx.account.accountId ?? "?"} in ${ofx.account.currency.code}`,
  );
  lines.push("");

  lines.push("Descriptions as the matcher will see them");
  for (const line of ofx.lines.slice(0, 5)) {
    lines.push(`  ${line.description.slice(0, 34).padEnd(36)}→  ${line.normalisedDescription}`);
  }

  return lines.join("\n");
}
