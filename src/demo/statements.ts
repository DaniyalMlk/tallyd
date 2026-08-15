/**
 * The financial statements over the receivables quarter. Run with:
 *
 *     npm run demo:reports
 */

import { dateRange, date } from "../ledger/date.js";
import { renderTrialBalance, trialBalance } from "../ledger/trialBalance.js";
import { incomeStatement, renderIncomeStatement } from "../reports/incomeStatement.js";
import { balanceSheet, renderBalanceSheet } from "../reports/balanceSheet.js";
import { ageing, renderAgeing } from "../reports/ageing.js";
import { receivablesLedger } from "./receivables.js";

export function statementsReport(): string {
  const ledger = receivablesLedger();
  const quarter = dateRange("2026-07-01", "2026-09-30");
  const priorQuarter = dateRange("2026-04-01", "2026-06-30");
  const asAt = date("2026-09-30");

  const out: string[] = [];

  out.push(renderIncomeStatement(incomeStatement(ledger, quarter, { comparative: priorQuarter })));
  out.push("");
  out.push("");
  out.push(renderBalanceSheet(balanceSheet(ledger, asAt)));
  out.push("");
  out.push("");
  out.push(renderAgeing(ageing(ledger, "1130", asAt)));
  out.push("");
  out.push("");
  out.push(renderTrialBalance(trialBalance(ledger, { asAt })));

  return out.join("\n");
}
