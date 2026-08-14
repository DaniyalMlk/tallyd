/**
 * Renders the demo month as text. `src/demo/main.ts` is the entry point that
 * prints it; keeping the two apart means tests can assert on the string
 * without a module side effect writing to stdout.
 */

import { renderTrialBalance, trialBalance, balancesByType, equationResidual } from "../ledger/trialBalance.js";
import { demoLedger } from "./month.js";

export function report(): string {
  const ledger = demoLedger();
  ledger.verify();

  const lines: string[] = [];
  lines.push(renderTrialBalance(trialBalance(ledger)));
  lines.push("");

  lines.push("By type");
  for (const [type, total] of [...balancesByType(ledger)].sort()) {
    lines.push(`  ${type.padEnd(10)} ${total.format().padStart(14)}`);
  }
  lines.push(`  ${"residual".padEnd(10)} ${equationResidual(ledger).format().padStart(14)}`);
  lines.push("");

  lines.push("Bank account movements");
  for (const row of ledger.statement("1110")) {
    lines.push(
      `  ${row.entry.date}  ${row.entry.narration.slice(0, 38).padEnd(40)}` +
        `${row.amount.toDecimalString().padStart(11)}${row.running.toDecimalString().padStart(13)}`,
    );
  }

  return lines.join("\n");
}
