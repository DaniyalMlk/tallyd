/**
 * A group that sold a company in September.
 *
 * The same shape as the mid-year purchase, and for the same reason: every
 * figure is a round number placed either side of the day control changed
 * hands, so a reader can say what the answer ought to be without doing any
 * arithmetic the code also does.
 *
 *     Harrowgate Holdings (GBP)
 *       80% -> Pellew Marine Ltd (GBP), bought 31 December 2024, sold 30 September 2026
 *
 * Sterling on both sides, deliberately: currency translation is tested
 * thoroughly elsewhere and here it would only stand between the reader and the
 * question, which is what happens to a company that is in the group for eight
 * months of a twelve-month period.
 *
 * The numbers, so they can be checked:
 *
 *     bought       net assets 350,000, price 400,000
 *                  the outside 20% measured proportionately: 70,000
 *                  goodwill 400,000 + 70,000 - 350,000 = 120,000
 *     1 Jan 2026   net assets 400,000, so 50,000 has been earned since
 *     to 30 Sep    100,000 earned, of which 20,000 is the outside stake's
 *     sold         net assets 500,000, price 600,000
 *                  the stake's claim 20% x 500,000 = 100,000
 *                  carrying amount 500,000 - 100,000 + 120,000 = 520,000
 *                  gain 600,000 - 520,000 = 80,000
 *
 * The holding company's own books make the gain 200,000: it paid 400,000 for
 * the shares and sold them for 600,000. Both figures are correct answers to
 * different questions, and the consolidation has to reverse the first to report
 * the second — otherwise the 120,000 of profit the company earned while it was
 * in the group, which the group has already reported as its own, would be
 * reported a second time as part of the gain.
 *
 * The company keeps trading afterwards and earns another 90,000 in November.
 * None of it is the group's, and the fact that it is on the same file is the
 * point: consolidating those books at 31 December rather than at 30 September
 * would take it, and would take a balance sheet the group does not own.
 */

import { GBP } from "../money/currency.js";
import { Money } from "../money/money.js";
import { JournalEntry } from "../ledger/entry.js";
import { Ledger } from "../ledger/ledger.js";
import { dateRange } from "../ledger/date.js";
import type { DateRange } from "../ledger/date.js";
import { RateTable } from "../fx/table.js";
import { groupChart } from "../group/accounts.js";
import { GroupStructure } from "../group/structure.js";
import type { AcquisitionInput } from "../group/acquisition.js";
import type { DisposalInput } from "../group/disposal.js";
import { type Consolidation, consolidate, renderConsolidation } from "../group/consolidate.js";
import { controlWindows, renderControlWindows } from "../group/timeline.js";
import { balanceSheet, renderBalanceSheet } from "../reports/balanceSheet.js";
import { incomeStatement, renderIncomeStatement } from "../reports/incomeStatement.js";

interface Leg {
  id: string;
  date: string;
  narration: string;
  debit: string;
  credit: string;
  amount: string;
}

function ledgerOf(legs: readonly Leg[]): Ledger {
  const chart = groupChart("GBP");
  return Ledger.from(
    legs.map((leg) =>
      JournalEntry.simple(
        {
          id: leg.id,
          date: leg.date,
          narration: leg.narration,
          debit: leg.debit,
          credit: leg.credit,
          amount: Money.parse(leg.amount, GBP),
        },
        chart,
      ),
    ),
    chart,
  );
}

export const DISPOSAL_AS_AT = "2026-12-31";
export const DISPOSAL_ACQUIRED = "2024-12-31";
export const DISPOSAL_SOLD = "2026-09-30";

export function disposalPeriod(): DateRange {
  return dateRange("2026-01-01", "2026-12-31");
}

export function disposalStructure(): GroupStructure {
  return GroupStructure.build(
    [
      { code: "HH", name: "Harrowgate Holdings", currency: GBP },
      {
        code: "PM",
        name: "Pellew Marine Ltd",
        currency: GBP,
        parent: "HH",
        holding: "80",
        acquired: DISPOSAL_ACQUIRED,
        disposed: DISPOSAL_SOLD,
        description: "Bought at the 2024 year end and sold at the end of September",
      },
    ],
    { presentation: "GBP", name: "The Harrowgate Group" },
  );
}

/**
 * The holder.
 *
 * Its own books have already recorded the sale: the investment is gone, the
 * cash is in, and the difference between the two — 200,000 — sits in its
 * income statement as a gain measured against what the shares cost. The
 * consolidation reverses exactly that figure and puts the group's in its place.
 */
export function harrowgateLedger(): Ledger {
  return ledgerOf([
    { id: "HH-01", date: "2024-06-30", narration: "Share capital subscribed", debit: "1110", credit: "3100", amount: "1000000.00" },
    { id: "HH-02", date: "2024-12-31", narration: "Acquired 80% of Pellew Marine", debit: "1230", credit: "1110", amount: "400000.00" },
    { id: "HH-03", date: "2025-12-31", narration: "Result for 2025 closed to reserves", debit: "4200", credit: "3200", amount: "150000.00" },
    { id: "HH-04", date: "2025-06-30", narration: "Consulting fees", debit: "1110", credit: "4200", amount: "150000.00" },
    { id: "HH-05", date: "2026-06-30", narration: "Consulting fees", debit: "1110", credit: "4200", amount: "240000.00" },
    { id: "HH-06", date: "2026-06-30", narration: "Salaries", debit: "5200", credit: "1110", amount: "160000.00" },
    { id: "HH-07", date: "2026-09-30", narration: "Sold Pellew Marine — proceeds", debit: "1110", credit: "1230", amount: "400000.00" },
    { id: "HH-08", date: "2026-09-30", narration: "Sold Pellew Marine — gain on the shares", debit: "1110", credit: "4970", amount: "200000.00" },
  ]);
}

/**
 * The company sold.
 *
 * Closed to reserves at each year end, so the balance on its income accounts
 * at any date is that year's result to that date and nothing else. It earns
 * 100,000 in the eight months to the sale and 90,000 in November, after it has
 * gone.
 */
export function pellewLedger(): Ledger {
  return ledgerOf([
    { id: "PM-01", date: "2023-01-01", narration: "Share capital subscribed", debit: "1110", credit: "3100", amount: "300000.00" },
    { id: "PM-02", date: "2024-06-30", narration: "Charter income", debit: "1110", credit: "4100", amount: "80000.00" },
    { id: "PM-03", date: "2024-09-30", narration: "Crew and fuel", debit: "5100", credit: "1110", amount: "30000.00" },
    { id: "PM-04", date: "2024-12-31", narration: "Result for 2024 closed to reserves", debit: "4100", credit: "3200", amount: "80000.00" },
    { id: "PM-05", date: "2024-12-31", narration: "Result for 2024 closed to reserves", debit: "3200", credit: "5100", amount: "30000.00" },
    { id: "PM-06", date: "2025-05-31", narration: "Charter income", debit: "1110", credit: "4100", amount: "90000.00" },
    { id: "PM-07", date: "2025-08-31", narration: "Crew and fuel", debit: "5100", credit: "1110", amount: "40000.00" },
    { id: "PM-08", date: "2025-12-31", narration: "Result for 2025 closed to reserves", debit: "4100", credit: "3200", amount: "90000.00" },
    { id: "PM-09", date: "2025-12-31", narration: "Result for 2025 closed to reserves", debit: "3200", credit: "5100", amount: "40000.00" },
    { id: "PM-10", date: "2026-04-30", narration: "Charter income", debit: "1110", credit: "4100", amount: "170000.00" },
    { id: "PM-11", date: "2026-07-31", narration: "Crew and fuel", debit: "5100", credit: "1110", amount: "70000.00" },
    { id: "PM-12", date: "2026-11-30", narration: "Charter income, under new owners", debit: "1110", credit: "4100", amount: "90000.00" },
  ]);
}

export function disposalLedgers(): Record<string, Ledger> {
  return { HH: harrowgateLedger(), PM: pellewLedger() };
}

export function disposalAcquisitions(): readonly AcquisitionInput[] {
  return [{ entity: "PM", consideration: Money.parse("400000.00", GBP) }];
}

export function disposalDisposals(): readonly DisposalInput[] {
  return [{ entity: "PM", proceeds: Money.parse("600000.00", GBP) }];
}

export function consolidateDisposal(): Consolidation {
  return consolidate(disposalStructure(), disposalLedgers(), {
    rates: RateTable.of([], { maxStaleDays: 5000 }),
    asAt: DISPOSAL_AS_AT,
    period: disposalPeriod(),
    acquisitions: disposalAcquisitions(),
    disposals: disposalDisposals(),
  });
}

export function disposalReport(): string {
  const group = disposalStructure();
  const result = consolidateDisposal();
  const label = (text: string, amount: Money): string =>
    `  ${text.padEnd(48)}${amount.toDecimalString().padStart(16)}`;

  const sections: string[] = [];
  sections.push("A company sold three months before the year end");
  sections.push("=".repeat(72));
  sections.push("");
  sections.push(group.render());
  sections.push("");
  sections.push(
    renderControlWindows(controlWindows(group, disposalPeriod()), (c) => group.get(c).name),
  );
  sections.push("");
  sections.push(
    "Pellew Marine earned 100,000 in the eight months to the sale and another " +
      "90,000 in November, under its new owners. Only the first is the group's, " +
      "and none of its balance sheet is.",
  );
  sections.push("");
  sections.push(renderConsolidation(result));
  sections.push("");

  const working = result.disposals[0];
  sections.push("Two answers to two different questions");
  sections.push("-".repeat(72));
  if (working !== undefined) {
    sections.push(label("Proceeds", working.disposal.proceeds));
    sections.push(
      label("Less what the holder paid for the shares", working.disposal.proceeds.minus(working.disposal.holderResult).negated()),
    );
    sections.push(label("The holder's own gain", working.disposal.holderResult));
    sections.push("");
    sections.push(label("Proceeds", working.disposal.proceeds));
    sections.push(label("Less net assets handed over", working.netAssetsRemoved.negated()));
    sections.push(label("Add back the outside stake's claim on them", working.nciRemoved));
    sections.push(label("Less goodwill derecognised", working.goodwillRemoved.negated()));
    sections.push(label("The group's gain", working.result));
    sections.push("");
    sections.push(
      "  The difference is " +
        working.disposal.holderResult.minus(working.result).toDecimalString() +
        ": the group's share of what the company earned and kept while it was " +
        "in the group. Every pound of it has already been reported as the " +
        "group's profit in this period or an earlier one, and reporting it " +
        "again inside the gain would be reporting it twice.",
    );
  }
  sections.push("");

  sections.push("What the group is left with");
  sections.push("-".repeat(72));
  sections.push(
    renderIncomeStatement(
      incomeStatement(result.ledger, result.period, { currency: result.presentation }),
    ),
  );
  sections.push("");
  sections.push(
    renderBalanceSheet(
      balanceSheet(result.ledger, result.asAt, { currency: result.presentation }),
    ),
  );
  sections.push("");
  sections.push(
    "  Nothing of Pellew Marine survives in the balance sheet: no charter " +
      "receipts, no goodwill, no outside stake. Its eight months of results are " +
      "in the income statement, and the outside stake still took its share of " +
      "them, because for those eight months the stake existed.",
  );
  sections.push("");
  sections.push(label("Accounting equation residual", result.residual));

  return sections.join("\n");
}
