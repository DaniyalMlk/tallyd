/**
 * A worked group: three companies, three currencies, and a company held
 * through another.
 *
 *     Halden Holdings (GBP)
 *       80% -> Halden Nord GmbH (EUR)
 *                75% -> Halden Systems Inc (USD)
 *
 * The group's interest in the American company is 60% and the outside stake is
 * 40%, which is neither of the two numbers the individual holdings offer. The
 * German company is held 80% and its outside stake is 20%.
 *
 * The intercompany relationships are the two that make consolidation
 * interesting rather than arithmetic: the parent has lent the German company
 * money and sold it goods, and the German company has repaid part of the loan
 * three days before the year end — money that neither company's cash shows and
 * both companies' intercompany accounts disagree about.
 */

import { EUR, GBP, USD } from "../money/currency.js";
import { Money } from "../money/money.js";
import { JournalEntry } from "../ledger/entry.js";
import { Ledger } from "../ledger/ledger.js";
import { dateRange } from "../ledger/date.js";
import type { DateRange } from "../ledger/date.js";
import type { ChartOfAccounts } from "../accounts/chart.js";
import type { Currency } from "../money/currency.js";
import { RateTable } from "../fx/table.js";
import { groupChart } from "../group/accounts.js";
import { GroupStructure } from "../group/structure.js";
import type { AcquisitionInput } from "../group/acquisition.js";
import type { IntercompanyDeclaration } from "../group/intercompany.js";

interface Leg {
  id: string;
  date: string;
  narration: string;
  debit: string;
  credit: string;
  amount: string;
}

function ledgerOf(chart: ChartOfAccounts, currency: Currency, legs: readonly Leg[]): Ledger {
  return Ledger.from(
    legs.map((leg) =>
      JournalEntry.simple(
        {
          id: leg.id,
          date: leg.date,
          narration: leg.narration,
          debit: leg.debit,
          credit: leg.credit,
          amount: Money.parse(leg.amount, currency),
        },
        chart,
      ),
    ),
    chart,
  );
}

/**
 * Rates that move, because a group whose currencies never moved would not test
 * anything. Sterling strengthens against both over the two years.
 */
export function groupRates(): RateTable {
  return RateTable.of(
    [
      { date: "2024-01-05", base: "EUR", quote: "GBP", rate: "0.8700" },
      { date: "2024-11-30", base: "EUR", quote: "GBP", rate: "0.8650" },
      { date: "2024-12-31", base: "EUR", quote: "GBP", rate: "0.8600" },
      { date: "2025-01-02", base: "EUR", quote: "GBP", rate: "0.8580" },
      { date: "2025-12-31", base: "EUR", quote: "GBP", rate: "0.8400" },
      { date: "2026-01-01", base: "EUR", quote: "GBP", rate: "0.8390" },
      { date: "2026-06-30", base: "EUR", quote: "GBP", rate: "0.8300" },
      { date: "2026-09-30", base: "EUR", quote: "GBP", rate: "0.8250" },
      { date: "2026-12-31", base: "EUR", quote: "GBP", rate: "0.8200" },
      { date: "2024-02-01", base: "USD", quote: "GBP", rate: "0.8000" },
      { date: "2024-09-30", base: "USD", quote: "GBP", rate: "0.7950" },
      { date: "2024-12-31", base: "USD", quote: "GBP", rate: "0.7900" },
      { date: "2025-01-02", base: "USD", quote: "GBP", rate: "0.7880" },
      { date: "2025-12-31", base: "USD", quote: "GBP", rate: "0.7700" },
      { date: "2026-01-01", base: "USD", quote: "GBP", rate: "0.7690" },
      { date: "2026-06-30", base: "USD", quote: "GBP", rate: "0.7600" },
      { date: "2026-09-30", base: "USD", quote: "GBP", rate: "0.7550" },
      { date: "2026-12-31", base: "USD", quote: "GBP", rate: "0.7500" },
    ],
    { maxStaleDays: 400 },
  );
}

export function groupStructure(): GroupStructure {
  return GroupStructure.build(
    [
      { code: "HH", name: "Halden Holdings", currency: GBP },
      {
        code: "HN",
        name: "Halden Nord GmbH",
        currency: EUR,
        parent: "HH",
        holding: "80",
        acquired: "2025-01-02",
        description: "Manufacturing, sells into the euro area",
      },
      {
        code: "HS",
        name: "Halden Systems Inc",
        currency: USD,
        parent: "HN",
        holding: "75",
        acquired: "2025-01-02",
        description: "Held through Nord, so the group's interest is 60%",
      },
    ],
    { presentation: "GBP", name: "The Halden Group" },
  );
}

/**
 * The parent: capital, two investments made on the same day, a loan to the
 * German company, goods sold to it, and its own trading.
 */
export function holdingsLedger(): Ledger {
  const chart = groupChart("GBP");
  return ledgerOf(chart, GBP, [
    { id: "HH-01", date: "2024-12-31", narration: "Share capital subscribed", debit: "1110", credit: "3100", amount: "900000.00" },
    { id: "HH-02", date: "2025-01-02", narration: "Acquired 80% of Halden Nord", debit: "1230", credit: "1110", amount: "260000.00" },
    { id: "HH-03", date: "2025-06-30", narration: "Consulting fees", debit: "1110", credit: "4200", amount: "180000.00" },
    { id: "HH-04", date: "2025-06-30", narration: "Salaries", debit: "5200", credit: "1110", amount: "120000.00" },
    { id: "HH-05", date: "2025-12-31", narration: "Result for 2025 closed to reserves", debit: "4200", credit: "3200", amount: "180000.00" },
    { id: "HH-06", date: "2025-12-31", narration: "Result for 2025 closed to reserves", debit: "3200", credit: "5200", amount: "120000.00" },
    { id: "HH-07", date: "2026-01-15", narration: "Loan to Halden Nord", debit: "1190", credit: "1110", amount: "150000.00" },
    { id: "HH-08", date: "2026-03-31", narration: "Goods sold to Halden Nord", debit: "1190", credit: "4950", amount: "60000.00" },
    { id: "HH-09", date: "2026-06-30", narration: "Consulting fees", debit: "1110", credit: "4200", amount: "240000.00" },
    { id: "HH-10", date: "2026-06-30", narration: "Salaries", debit: "5200", credit: "1110", amount: "150000.00" },
    { id: "HH-11", date: "2026-09-30", narration: "Rent", debit: "5300", credit: "1110", amount: "48000.00" },
    { id: "HH-12", date: "2026-11-30", narration: "Professional fees", debit: "5700", credit: "1110", amount: "22000.00" },
  ]);
}

/**
 * The German company. Its net assets at acquisition were 300,000 EUR: capital
 * of 250,000 and 50,000 of reserves already earned, which are pre-acquisition
 * and belong to nobody in the group.
 */
export function nordLedger(): Ledger {
  const chart = groupChart("EUR");
  return ledgerOf(chart, EUR, [
    { id: "HN-01", date: "2024-01-05", narration: "Share capital subscribed", debit: "1110", credit: "3100", amount: "250000.00" },
    { id: "HN-02", date: "2024-11-30", narration: "Reserves earned before the acquisition", debit: "1110", credit: "3200", amount: "50000.00" },
    { id: "HN-03", date: "2025-01-02", narration: "Acquired 75% of Halden Systems", debit: "1230", credit: "1110", amount: "150000.00" },
    { id: "HN-04", date: "2025-06-30", narration: "Sales", debit: "1110", credit: "4100", amount: "420000.00" },
    { id: "HN-05", date: "2025-06-30", narration: "Cost of sales", debit: "5100", credit: "1110", amount: "300000.00" },
    { id: "HN-06", date: "2025-12-31", narration: "Result for 2025 closed to reserves", debit: "4100", credit: "3200", amount: "420000.00" },
    { id: "HN-07", date: "2025-12-31", narration: "Result for 2025 closed to reserves", debit: "3200", credit: "5100", amount: "300000.00" },
    { id: "HN-08", date: "2026-01-15", narration: "Loan from Halden Holdings", debit: "1110", credit: "2190", amount: "178784.27" },
    { id: "HN-09", date: "2026-03-31", narration: "Goods from Halden Holdings", debit: "5960", credit: "2190", amount: "72289.16" },
    { id: "HN-10", date: "2026-06-30", narration: "Sales", debit: "1110", credit: "4100", amount: "560000.00" },
    { id: "HN-11", date: "2026-06-30", narration: "Cost of sales", debit: "5100", credit: "1110", amount: "395000.00" },
    { id: "HN-12", date: "2026-09-30", narration: "Salaries", debit: "5200", credit: "1110", amount: "84000.00" },
    { id: "HN-13", date: "2026-12-28", narration: "Loan repayment to Halden Holdings", debit: "2190", credit: "1110", amount: "60000.00" },
  ]);
}

/**
 * The American company, held through Nord. Its net assets at acquisition were
 * 160,000 USD.
 */
export function systemsLedger(): Ledger {
  const chart = groupChart("USD");
  return ledgerOf(chart, USD, [
    { id: "HS-01", date: "2024-02-01", narration: "Share capital subscribed", debit: "1110", credit: "3100", amount: "140000.00" },
    { id: "HS-02", date: "2024-09-30", narration: "Reserves earned before the acquisition", debit: "1110", credit: "3200", amount: "20000.00" },
    { id: "HS-03", date: "2025-06-30", narration: "Sales", debit: "1110", credit: "4100", amount: "300000.00" },
    { id: "HS-04", date: "2025-06-30", narration: "Cost of sales", debit: "5100", credit: "1110", amount: "215000.00" },
    { id: "HS-05", date: "2025-12-31", narration: "Result for 2025 closed to reserves", debit: "4100", credit: "3200", amount: "300000.00" },
    { id: "HS-06", date: "2025-12-31", narration: "Result for 2025 closed to reserves", debit: "3200", credit: "5100", amount: "215000.00" },
    { id: "HS-07", date: "2026-06-30", narration: "Sales", debit: "1110", credit: "4100", amount: "380000.00" },
    { id: "HS-08", date: "2026-06-30", narration: "Cost of sales", debit: "5100", credit: "1110", amount: "268000.00" },
    { id: "HS-09", date: "2026-09-30", narration: "Software", debit: "5400", credit: "1110", amount: "36000.00" },
  ]);
}

export function groupLedgers(): Record<string, Ledger> {
  return { HH: holdingsLedger(), HN: nordLedger(), HS: systemsLedger() };
}

/**
 * The loan and the trading, each declared from both ends.
 *
 * They need naming: two accounts in the parent's books face the same company,
 * and without a link the loan would pair against the German company's
 * purchases.
 */
export function groupIntercompany(): readonly IntercompanyDeclaration[] {
  return [
    { entity: "HH", account: "1190", counterparty: "HN", link: "loan", note: "loan and trading account" },
    { entity: "HN", account: "2190", counterparty: "HH", link: "loan" },
    { entity: "HH", account: "4950", counterparty: "HN", link: "trading" },
    { entity: "HN", account: "5960", counterparty: "HH", link: "trading" },
  ];
}

export function groupAcquisitions(): readonly AcquisitionInput[] {
  return [
    { entity: "HN", consideration: Money.parse("260000.00", GBP) },
    {
      entity: "HS",
      acquired: "2025-01-02",
      consideration: Money.parse("150000.00", EUR),
      nciMeasurement: "fair-value",
      nciFairValue: Money.parse("72000.00", USD),
    },
  ];
}

export function groupPeriod(): DateRange {
  return dateRange("2026-01-01", "2026-12-31");
}

export const GROUP_AS_AT = "2026-12-31";
