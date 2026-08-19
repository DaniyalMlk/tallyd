/**
 * The Halden group, consolidated and printed.
 *
 * The sections are in the order somebody preparing the accounts works in:
 * who owns whom, what the books look like added together, what the group owes
 * itself, what was paid for each subsidiary, and then the statements that come
 * out of it. The last section is the one to read: it checks the consolidated
 * balance sheet's equity against what the workings say it should be, so a
 * mistake anywhere upstream shows up as a number that does not agree rather
 * than as a plausible statement.
 */

import { Money } from "../money/money.js";
import { GBP } from "../money/currency.js";
import { renderTrialBalance } from "../ledger/trialBalance.js";
import { balanceSheet, renderBalanceSheet } from "../reports/balanceSheet.js";
import { incomeStatement, renderIncomeStatement } from "../reports/incomeStatement.js";
import { renderAggregation } from "../group/aggregate.js";
import { renderEliminations } from "../group/intercompany.js";
import { renderAcquisition } from "../group/acquisition.js";
import { consolidate, renderConsolidation } from "../group/consolidate.js";
import {
  GROUP_AS_AT,
  groupAcquisitions,
  groupIntercompany,
  groupLedgers,
  groupPeriod,
  groupRates,
  groupStructure,
} from "./group.js";

export function consolidatedGroup() {
  return consolidate(groupStructure(), groupLedgers(), {
    rates: groupRates(),
    asAt: GROUP_AS_AT,
    period: groupPeriod(),
    averageMethod: "daily",
    intercompany: groupIntercompany(),
    acquisitions: groupAcquisitions(),
  });
}

export function groupReport(): string {
  const result = consolidatedGroup();
  const sections: string[] = [];

  sections.push("A group of three companies in three currencies");
  sections.push("=".repeat(72));
  sections.push("");
  sections.push(result.group.render());
  sections.push("");

  sections.push("Added together, before anything is taken out");
  sections.push("-".repeat(72));
  sections.push(renderAggregation(result.aggregation));
  sections.push("");

  sections.push("What the group owes and sells to itself");
  sections.push("-".repeat(72));
  sections.push(renderEliminations(result.eliminations));
  sections.push("");

  sections.push("What was paid, and for what");
  sections.push("-".repeat(72));
  for (const working of result.workings) {
    sections.push(renderAcquisition(working.acquisition));
    sections.push("");
  }

  sections.push("The consolidation");
  sections.push("-".repeat(72));
  sections.push(renderConsolidation(result));
  sections.push("");

  sections.push("Consolidated statements");
  sections.push("-".repeat(72));
  sections.push(renderTrialBalance(result.trialBalance));
  sections.push("");
  sections.push(renderIncomeStatement(incomeStatement(result.ledger, result.period, { currency: GBP })));
  sections.push("");
  sections.push(renderBalanceSheet(balanceSheet(result.ledger, result.asAt, { currency: GBP })));
  sections.push("");

  // ------------------------------------------------------------ the check
  //
  // The equity on the face of the balance sheet, split the way the workings
  // say it splits. If the two ever disagreed, something upstream would have
  // gone into the wrong half of the group.
  const sheet = balanceSheet(result.ledger, result.asAt, { currency: GBP });
  const outsideStake = result.workings.reduce(
    (running, working) => running.plus(working.nciClosing),
    Money.zero(GBP),
  );
  const totalEquity = sheet.equity.total;
  const parentOwners = totalEquity.minus(outsideStake);

  sections.push("Does it hang together");
  sections.push("-".repeat(72));
  sections.push(`  Total equity on the balance sheet      ${totalEquity.toDecimalString().padStart(16)}`);
  sections.push(`  Attributable to the parent's owners    ${parentOwners.toDecimalString().padStart(16)}`);
  sections.push(`  Attributable to the outside stakes     ${outsideStake.toDecimalString().padStart(16)}`);
  sections.push(
    `  Balance sheet balances                 ${String(sheet.balanced).padStart(16)}`,
  );
  sections.push(
    `  Accounting equation residual           ${result.residual.toDecimalString().padStart(16)}`,
  );
  sections.push(
    `  Non-controlling interest as booked     ${result.nonControllingInterest.toDecimalString().padStart(16)}`,
  );
  sections.push(
    outsideStake.equals(result.nonControllingInterest)
      ? "  The workings and the ledger agree on what belongs to whom."
      : "  THE WORKINGS AND THE LEDGER DISAGREE",
  );

  return sections.join("\n");
}
