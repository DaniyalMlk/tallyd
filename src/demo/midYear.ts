/**
 * A group that bought a company in April.
 *
 * Everything here exists to make one figure checkable by hand. The subsidiary
 * earns 60,000 in the first quarter and 120,000 over the rest of the year, in
 * transactions dated either side of the day control changed hands, so a reader
 * can say what the group's share of it ought to be without doing any
 * arithmetic the code also does.
 *
 *     Fenwick Group (GBP)
 *       75% -> Aldermere Ltd (GBP), acquired 1 April 2026
 *
 * Sterling on both sides, deliberately. Currency translation is tested
 * thoroughly elsewhere and here it would only be noise between the reader and
 * the question, which is what part of a year belongs to whom.
 *
 * The report prints the same group twice: once consolidating only the part of
 * the year the group owned the company for, and once taking the whole year
 * regardless. The second is what the consolidation did before it knew about
 * control windows, and it is worth printing rather than describing, because
 * the way it is wrong is not obvious. Every total still balances. The
 * accounting equation still closes to nil. What is wrong is that the group
 * reports revenue earned by somebody else, hands the outside stake a share of
 * a profit made before the stake existed, and shows a *negative* figure for
 * post-acquisition reserves — which is the only visible symptom, and only if
 * you know to look at it.
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
import { type Consolidation, consolidate, renderConsolidation } from "../group/consolidate.js";
import { controlWindows, renderControlWindows } from "../group/timeline.js";

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

export const MID_YEAR_AS_AT = "2026-12-31";
export const MID_YEAR_ACQUIRED = "2026-04-01";

export function midYearPeriod(): DateRange {
  return dateRange("2026-01-01", "2026-12-31");
}

export function midYearStructure(): GroupStructure {
  return GroupStructure.build(
    [
      { code: "FG", name: "Fenwick Group", currency: GBP },
      {
        code: "AL",
        name: "Aldermere Ltd",
        currency: GBP,
        parent: "FG",
        holding: "75",
        acquired: MID_YEAR_ACQUIRED,
        description: "Bought on the first of April, a quarter into the year",
      },
    ],
    { presentation: "GBP", name: "The Fenwick Group" },
  );
}

/** The buyer. Capital, the purchase, and its own trading. */
export function fenwickLedger(): Ledger {
  return ledgerOf([
    { id: "FG-01", date: "2025-12-31", narration: "Share capital subscribed", debit: "1110", credit: "3100", amount: "1000000.00" },
    { id: "FG-02", date: "2026-04-01", narration: "Acquired 75% of Aldermere", debit: "1230", credit: "1110", amount: "260000.00" },
    { id: "FG-03", date: "2026-06-30", narration: "Consulting fees", debit: "1110", credit: "4200", amount: "300000.00" },
    { id: "FG-04", date: "2026-06-30", narration: "Salaries", debit: "5200", credit: "1110", amount: "180000.00" },
  ]);
}

/**
 * The company bought.
 *
 * Its books were closed at the 2025 year end, so 40,000 of reserves is what it
 * had before the year opened. The first quarter earns 60,000 and the nine
 * months after the sale earn 120,000, and both are in round numbers on purpose.
 */
export function aldermereLedger(): Ledger {
  return ledgerOf([
    { id: "AL-01", date: "2024-06-30", narration: "Share capital subscribed", debit: "1110", credit: "3100", amount: "200000.00" },
    { id: "AL-02", date: "2025-06-30", narration: "Sales", debit: "1110", credit: "4100", amount: "40000.00" },
    { id: "AL-03", date: "2025-12-31", narration: "Result for 2025 closed to reserves", debit: "4100", credit: "3200", amount: "40000.00" },
    { id: "AL-04", date: "2026-02-15", narration: "Sales", debit: "1110", credit: "4100", amount: "160000.00" },
    { id: "AL-05", date: "2026-03-20", narration: "Cost of sales", debit: "5100", credit: "1110", amount: "100000.00" },
    { id: "AL-06", date: "2026-08-31", narration: "Sales", debit: "1110", credit: "4100", amount: "300000.00" },
    { id: "AL-07", date: "2026-09-30", narration: "Cost of sales", debit: "5100", credit: "1110", amount: "180000.00" },
  ]);
}

export function midYearLedgers(): Record<string, Ledger> {
  return { FG: fenwickLedger(), AL: aldermereLedger() };
}

export function midYearAcquisitions(): readonly AcquisitionInput[] {
  return [{ entity: "AL", consideration: Money.parse("260000.00", GBP) }];
}

/** Consolidate it, either honestly or the way it used to be done. */
export function consolidateMidYear(wholePeriodRegardless = false): Consolidation {
  return consolidate(midYearStructure(), midYearLedgers(), {
    rates: RateTable.of([], { maxStaleDays: 5000 }),
    asAt: MID_YEAR_AS_AT,
    period: midYearPeriod(),
    acquisitions: midYearAcquisitions(),
    ...(wholePeriodRegardless ? { wholePeriodRegardless: true } : {}),
  });
}

export function midYearReport(): string {
  const group = midYearStructure();
  const honest = consolidateMidYear(false);
  const naive = consolidateMidYear(true);
  const label = (text: string, amount: Money): string =>
    `  ${text.padEnd(48)}${amount.toDecimalString().padStart(16)}`;

  const sections: string[] = [];
  sections.push("A company bought a quarter of the way through the year");
  sections.push("=".repeat(72));
  sections.push("");
  sections.push(group.render());
  sections.push("");
  sections.push(renderControlWindows(controlWindows(group, midYearPeriod()), (c) => group.get(c).name));
  sections.push("");
  sections.push(
    "Aldermere earned 60,000 in the first quarter and 120,000 over the nine months " +
      "after the sale. Only the second figure is the group's.",
  );
  sections.push("");

  sections.push("Consolidated for the part of the year the group owned it");
  sections.push("-".repeat(72));
  sections.push(renderConsolidation(honest));
  sections.push("");

  sections.push("And the same books taking the whole year regardless");
  sections.push("-".repeat(72));
  sections.push(renderConsolidation(naive));
  sections.push("");

  const honestWorking = honest.workings[0];
  const naiveWorking = naive.workings[0];
  sections.push("What the difference costs");
  sections.push("-".repeat(72));
  if (honestWorking !== undefined && naiveWorking !== undefined) {
    sections.push(label("Result the group is entitled to", honestWorking.profitForPeriod));
    sections.push(label("Result taking the whole year", naiveWorking.profitForPeriod));
    sections.push(
      label("Overstated by", naiveWorking.profitForPeriod.minus(honestWorking.profitForPeriod)),
    );
    sections.push("");
    sections.push(label("Outside stake's share, correctly", honestWorking.nciProfitShare));
    sections.push(label("Outside stake's share, taking the year", naiveWorking.nciProfitShare));
    sections.push("");
    sections.push(
      label("Post-acquisition reserves, correctly", honestWorking.postAcquisitionReserves),
    );
    sections.push(
      label("Post-acquisition reserves, taking the year", naiveWorking.postAcquisitionReserves),
    );
    sections.push("");
    sections.push(
      "  Both balance. Both close the accounting equation to nil. The second is " +
        "wrong, and the only sign of it on the face of the workings is a negative " +
        "figure for reserves earned since control was obtained — reserves that, on " +
        "those numbers, would have had to be earned backwards.",
    );
  }
  sections.push("");
  sections.push(label("The group's closing balance sheet is unaffected", honest.residual));
  sections.push(
    `  Net assets at the reporting date are the same either way: ` +
      `${honestWorking?.netAssetsNow.toDecimalString()} against ` +
      `${naiveWorking?.netAssetsNow.toDecimalString()}. Only the split between what ` +
      `was bought and what was earned moves.`,
  );

  return sections.join("\n");
}
