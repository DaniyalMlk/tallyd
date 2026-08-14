/**
 * A small-business chart of accounts, used as the default in the CLI and as
 * fixture data in tests.
 *
 * The codes follow the usual 1000/2000/3000/4000/5000 blocks so the ordering
 * of a trial balance printed by code matches the order of a balance sheet.
 */

import type { AccountDefinition } from "./chart.js";
import { ChartOfAccounts } from "./chart.js";
import type { Currency } from "../money/currency.js";

export const STANDARD_ACCOUNTS: readonly AccountDefinition[] = [
  // 1000 — assets
  { code: "1000", name: "Assets", type: "asset", placeholder: true },
  { code: "1100", name: "Current Assets", type: "asset", parent: "1000", placeholder: true },
  {
    code: "1110",
    name: "Bank",
    type: "asset",
    parent: "1100",
    description: "Operating current account, reconciled against statements",
  },
  { code: "1120", name: "Petty Cash", type: "asset", parent: "1100" },
  {
    code: "1130",
    name: "Accounts Receivable",
    type: "asset",
    parent: "1100",
    description: "Invoiced but unpaid",
  },
  {
    code: "1140",
    name: "Undeposited Funds",
    type: "asset",
    parent: "1100",
    description: "Captured by the processor, not yet settled to the bank",
  },
  { code: "1150", name: "Prepaid Expenses", type: "asset", parent: "1100" },
  { code: "1200", name: "Fixed Assets", type: "asset", parent: "1000", placeholder: true },
  { code: "1210", name: "Equipment", type: "asset", parent: "1200" },
  {
    code: "1220",
    name: "Accumulated Depreciation",
    type: "asset",
    parent: "1200",
    description: "Contra-asset; carries a credit balance",
  },

  // 2000 — liabilities
  { code: "2000", name: "Liabilities", type: "liability", placeholder: true },
  { code: "2100", name: "Accounts Payable", type: "liability", parent: "2000" },
  { code: "2200", name: "VAT Payable", type: "liability", parent: "2000" },
  { code: "2300", name: "Payroll Liabilities", type: "liability", parent: "2000" },
  { code: "2400", name: "Credit Card", type: "liability", parent: "2000" },

  // 3000 — equity
  { code: "3000", name: "Equity", type: "equity", placeholder: true },
  { code: "3100", name: "Share Capital", type: "equity", parent: "3000" },
  { code: "3200", name: "Retained Earnings", type: "equity", parent: "3000" },
  { code: "3300", name: "Drawings", type: "equity", parent: "3000" },

  // 4000 — income
  { code: "4000", name: "Income", type: "income", placeholder: true },
  { code: "4100", name: "Sales", type: "income", parent: "4000" },
  { code: "4200", name: "Consulting", type: "income", parent: "4000" },
  { code: "4300", name: "Interest Income", type: "income", parent: "4000" },

  // 5000 — expenses
  { code: "5000", name: "Expenses", type: "expense", placeholder: true },
  { code: "5100", name: "Cost of Sales", type: "expense", parent: "5000" },
  { code: "5200", name: "Salaries", type: "expense", parent: "5000" },
  { code: "5300", name: "Rent", type: "expense", parent: "5000" },
  { code: "5400", name: "Software", type: "expense", parent: "5000" },
  {
    code: "5500",
    name: "Payment Processing Fees",
    type: "expense",
    parent: "5000",
    description: "The gap that makes a deposit fail to match its invoice",
  },
  { code: "5600", name: "Travel", type: "expense", parent: "5000" },
  { code: "5700", name: "Professional Fees", type: "expense", parent: "5000" },
  { code: "5800", name: "Bank Charges", type: "expense", parent: "5000" },
  { code: "5900", name: "Depreciation", type: "expense", parent: "5000" },
];

export function standardChart(currency: Currency | string = "GBP"): ChartOfAccounts {
  return ChartOfAccounts.build(STANDARD_ACCOUNTS, { currency });
}
