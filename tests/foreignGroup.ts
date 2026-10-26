/**
 * A cross-border group whose exchange rate moves.
 *
 * Every other group fixture in this suite holds EUR/GBP at 0.50 on every date
 * that matters. That keeps their hand-worked figures checkable, and it means
 * not one of them can tell a closing rate from an acquisition rate from an
 * average rate: a figure carried at the wrong one comes out as the same
 * number. This fixture drifts from 0.80 on the day control was obtained to
 * 0.90 at the second reporting date, so taking the wrong rate shows up.
 *
 *   S was formed on 2024-12-31 with 60,000 EUR of capital and nothing else had
 *   happened when P bought 80% of it on 2025-01-01 for 80,000 GBP. EUR/GBP was
 *   0.80 that day, so the price was 100,000 EUR.
 *
 * Worked by hand, in euro, which is the currency the arithmetic belongs in:
 *
 *   Consideration                     = 80,000 GBP / 0.80  = 100,000 EUR
 *   NCI at acquisition, proportionate = 20% x 60,000        =  12,000 EUR
 *   Goodwill                          = 100,000 + 12,000 - 60,000
 *                                                           =  52,000 EUR
 *   Goodwill at the acquisition rate  = 52,000 x 0.80        =  41,600 GBP
 *   Goodwill at the 2026 closing rate = 52,000 x 0.90        =  46,800 GBP
 *
 * S then earns 20,000 EUR of reserves in 2025 and 10,000 EUR in 2026, so its
 * net assets are 80,000 EUR at the first reporting date and 90,000 EUR at the
 * second.
 */

import { JournalEntry } from "../src/ledger/entry.js";
import { Ledger } from "../src/ledger/ledger.js";
import type { ChartOfAccounts } from "../src/accounts/chart.js";
import type { Currency } from "../src/money/currency.js";
import { EUR, GBP } from "../src/money/currency.js";
import { Money } from "../src/money/money.js";
import { RateTable } from "../src/fx/table.js";
import { GroupStructure } from "../src/group/structure.js";
import { groupChart } from "../src/group/accounts.js";
import type { AcquisitionInput } from "../src/group/acquisition.js";

export const GBP_CHART = groupChart("GBP");
export const EUR_CHART = groupChart("EUR");

export interface Leg {
  id: string;
  date: string;
  narration: string;
  debit: string;
  credit: string;
  amount: string;
}

export function ledgerOf(
  chart: ChartOfAccounts,
  currency: Currency,
  legs: readonly Leg[],
): Ledger {
  return Ledger.from(
    legs.map((leg) => JournalEntry.simple({ ...leg, amount: Money.parse(leg.amount, currency) }, chart)),
    chart,
  );
}

export const FOREIGN_PARENT = ledgerOf(GBP_CHART, GBP, [
  { id: "P-CAP", date: "2024-12-31", narration: "Capital", debit: "1110", credit: "3100", amount: "500000.00" },
  { id: "P-INV", date: "2025-01-01", narration: "Bought 80% of S", debit: "1230", credit: "1110", amount: "80000.00" },
]);

export const FOREIGN_SUB = ledgerOf(EUR_CHART, EUR, [
  { id: "S-CAP", date: "2024-12-31", narration: "Capital", debit: "1110", credit: "3100", amount: "60000.00" },
  { id: "S-INC-25", date: "2025-06-30", narration: "Sales", debit: "1110", credit: "4100", amount: "50000.00" },
  { id: "S-EXP-25", date: "2025-06-30", narration: "Cost of sales", debit: "5100", credit: "1110", amount: "30000.00" },
  { id: "S-CLOSE", date: "2025-12-31", narration: "Result to reserves", debit: "4100", credit: "3200", amount: "50000.00" },
  { id: "S-CLOSE2", date: "2025-12-31", narration: "Result to reserves", debit: "3200", credit: "5100", amount: "30000.00" },
  { id: "S-INC-26", date: "2026-06-30", narration: "Sales", debit: "1110", credit: "4100", amount: "40000.00" },
  { id: "S-EXP-26", date: "2026-06-30", narration: "Cost of sales", debit: "5100", credit: "1110", amount: "30000.00" },
]);

/** EUR/GBP at 0.80 through 2025, drifting to 0.90 by the end of 2026. */
export const MOVING_RATES = RateTable.of(
  [
    { date: "2024-12-01", base: "EUR", quote: "GBP", rate: "0.8000" },
    { date: "2024-12-31", base: "EUR", quote: "GBP", rate: "0.8000" },
    { date: "2025-06-30", base: "EUR", quote: "GBP", rate: "0.8000" },
    { date: "2025-12-31", base: "EUR", quote: "GBP", rate: "0.8000" },
    { date: "2026-01-31", base: "EUR", quote: "GBP", rate: "0.8200" },
    { date: "2026-03-31", base: "EUR", quote: "GBP", rate: "0.8400" },
    { date: "2026-06-30", base: "EUR", quote: "GBP", rate: "0.8500" },
    { date: "2026-09-30", base: "EUR", quote: "GBP", rate: "0.8700" },
    { date: "2026-12-31", base: "EUR", quote: "GBP", rate: "0.9000" },
  ],
  { maxStaleDays: 400 },
);

export const FOREIGN_GROUP = GroupStructure.build(
  [
    { code: "P", name: "Parent Ltd", currency: GBP },
    { code: "S", name: "Sub GmbH", currency: EUR, parent: "P", holding: "80", acquired: "2025-01-01" },
  ],
  { presentation: "GBP", name: "Cross-border Group" },
);

export const FOREIGN_LEDGERS = { P: FOREIGN_PARENT, S: FOREIGN_SUB };

export const FOREIGN_ACQUISITION: AcquisitionInput = {
  entity: "S",
  consideration: Money.parse("80000.00", GBP),
};
