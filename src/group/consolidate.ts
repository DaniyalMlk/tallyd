/**
 * The whole thing, assembled into a ledger.
 *
 * A consolidation could be a table of numbers, and most of them are. This one
 * produces a `Ledger` instead: every step is a balanced journal entry, and the
 * result is a real set of books in the presentation currency that every report
 * already written works on, that can be serialised, and that can be read back
 * and checked. Nothing is adjusted invisibly. If a figure in the consolidated
 * balance sheet is wrong, there is an entry with a narration that put it there.
 *
 * Four kinds of entry go in, in order.
 *
 * 1. **One per entity**, carrying its translated trial balance. It balances
 *    because the translation adjustment is posted with it, to the translation
 *    reserve, where it belongs.
 * 2. **The intercompany eliminations**, which remove what the group owes and
 *    sells to itself and leave any disagreement in a named account.
 * 3. **One per subsidiary**, which removes that subsidiary's own equity and
 *    the parent's investment in it, and puts goodwill and the non-controlling
 *    interest in their place. The balancing figure is the group's share of the
 *    reserves earned since control was obtained — and it comes out to exactly
 *    `groupInterest x (equity removed + net assets at acquisition)`, which the
 *    tests check rather than assume.
 * 4. **One per subsidiary with an outside stake**, moving that stake's share
 *    of this period's profit out of the result attributable to the parent's
 *    owners and into the non-controlling interest. Without it the totals are
 *    still right and the presentation is wrong: the whole profit would read as
 *    the group's, and the reserves brought forward would be short by exactly
 *    the same amount.
 *
 * The non-controlling interest's claim is computed as its share of the net
 * assets now, plus whatever goodwill was attributed to it at acquisition. That
 * needs no roll-forward from one period to the next and so cannot drift, which
 * a schedule of movements can.
 */

import { Money, sumMoney } from "../money/money.js";
import type { Currency } from "../money/currency.js";
import type { RoundingMode } from "../money/rounding.js";
import type { AccountDefinition } from "../accounts/chart.js";
import { ChartOfAccounts } from "../accounts/chart.js";
import type { AccountType } from "../accounts/types.js";
import type { CalendarDate, DateRange } from "../ledger/date.js";
import { JournalEntry, type PostingInput } from "../ledger/entry.js";
import { Ledger } from "../ledger/ledger.js";
import { equationResidual, trialBalance, type TrialBalance } from "../ledger/trialBalance.js";
import type { RateTable } from "../fx/table.js";
import type { AverageMethod } from "../fx/average.js";
import { type Aggregation, type AggregationOptions, type EntityLedgers, aggregate } from "./aggregate.js";
import { CONSOLIDATION_ACCOUNTS, GROUP_ACCOUNTS } from "./accounts.js";
import { type Acquisition, type AcquisitionInput, acquisitions } from "./acquisition.js";
import {
  type EliminationOptions,
  type Eliminations,
  type IntercompanyDeclaration,
  eliminateIntercompany,
} from "./intercompany.js";
import type { GroupStructure } from "./structure.js";

/** What each subsidiary contributed to the group's equity, and to whose share. */
export interface SubsidiaryWorking {
  readonly entity: string;
  readonly acquisition: Acquisition;
  /** The subsidiary's own equity accounts, translated, as removed. */
  readonly equityRemoved: Money;
  /** Its net assets at the reporting date, in the presentation currency. */
  readonly netAssetsNow: Money;
  /** Its result for the period, in the presentation currency. */
  readonly profitForPeriod: Money;
  /** The outside stake's share of that result. */
  readonly nciProfitShare: Money;
  /** The outside stake's claim at the reporting date, goodwill included. */
  readonly nciClosing: Money;
  /** The group's share of reserves earned since control was obtained. */
  readonly postAcquisitionReserves: Money;
}

export interface Consolidation {
  readonly group: GroupStructure;
  readonly presentation: Currency;
  readonly asAt: CalendarDate;
  readonly period: DateRange;
  readonly aggregation: Aggregation;
  readonly eliminations: Eliminations;
  readonly workings: readonly SubsidiaryWorking[];
  /** The consolidated books: every step above, as entries. */
  readonly ledger: Ledger;
  readonly chart: ChartOfAccounts;
  readonly trialBalance: TrialBalance;
  readonly goodwill: Money;
  readonly bargainGain: Money;
  readonly nonControllingInterest: Money;
  readonly translationReserve: Money;
  /** Left in the investment account after the eliminations, which should be nil. */
  readonly investmentResidual: Money;
  /** Assets less liabilities less equity less the result. Nil when it hangs together. */
  readonly residual: Money;
  readonly balanced: boolean;
}

export interface ConsolidationOptions {
  rates: RateTable;
  asAt: string;
  period?: DateRange;
  averageMethod?: AverageMethod;
  equityBasis?: "historical" | "closing";
  rounding?: RoundingMode;
  intercompany?: readonly IntercompanyDeclaration[];
  acquisitions?: readonly AcquisitionInput[];
  /** Passed through to the elimination pass. */
  elimination?: Omit<EliminationOptions, "chart">;
}

function sumRows(
  aggregation: Aggregation,
  entity: string,
  types: readonly (AccountType | null)[],
): Money {
  const contribution = aggregation.entities.find((c) => c.entity === entity);
  const zero = Money.zero(aggregation.presentation);
  if (contribution === undefined) return zero;
  return contribution.translation.rows
    .filter((row) => types.includes(row.type))
    .reduce((running, row) => running.plus(row.presentation), zero);
}

/**
 * A chart wide enough for the result.
 *
 * The group accounts plus every code any entity actually used, because books
 * kept on different charts are the ordinary case and a consolidation that
 * refused an account it had not seen before would be unusable.
 */
function consolidatedChart(aggregation: Aggregation, presentation: Currency): ChartOfAccounts {
  const definitions: AccountDefinition[] = [
    { code: "1000", name: "Assets", type: "asset", placeholder: true },
    { code: "1100", name: "Current Assets", type: "asset", parent: "1000", placeholder: true },
    { code: "1200", name: "Fixed Assets", type: "asset", parent: "1000", placeholder: true },
    { code: "2000", name: "Liabilities", type: "liability", placeholder: true },
    { code: "3000", name: "Equity", type: "equity", placeholder: true },
    { code: "4000", name: "Income", type: "income", placeholder: true },
    { code: "5000", name: "Expenses", type: "expense", placeholder: true },
    ...CONSOLIDATION_ACCOUNTS,
    { code: "3100", name: "Share Capital", type: "equity", parent: "3000" },
    { code: "3200", name: "Retained Earnings", type: "equity", parent: "3000" },
  ];
  const known = new Set(definitions.map((d) => d.code));
  const parentOf = (type: AccountType | null): string | undefined => {
    switch (type) {
      case "asset":
        return "1100";
      case "liability":
        return "2000";
      case "equity":
        return "3000";
      case "income":
        return "4000";
      case "expense":
        return "5000";
      default:
        return undefined;
    }
  };
  for (const row of aggregation.rows) {
    if (known.has(row.account)) continue;
    known.add(row.account);
    const parent = parentOf(row.type);
    definitions.push({
      code: row.account,
      name: row.name,
      type: row.type ?? "asset",
      ...(parent === undefined ? {} : { parent }),
    });
  }
  return ChartOfAccounts.build(definitions, { currency: presentation });
}

/** Build the group's accounts. */
export function consolidate(
  group: GroupStructure,
  ledgers: EntityLedgers,
  options: ConsolidationOptions,
): Consolidation {
  const presentation = group.presentation;
  const zero = Money.zero(presentation);
  const rounding = options.rounding ?? "half-even";

  const aggregationOptions: AggregationOptions = {
    rates: options.rates,
    asAt: options.asAt,
    ...(options.period === undefined ? {} : { period: options.period }),
    ...(options.averageMethod === undefined ? {} : { averageMethod: options.averageMethod }),
    ...(options.equityBasis === undefined ? {} : { equityBasis: options.equityBasis }),
    rounding,
  };
  const aggregation = aggregate(group, ledgers, aggregationOptions);
  const chart = consolidatedChart(aggregation, presentation);

  const eliminations = eliminateIntercompany(
    group,
    aggregation,
    options.intercompany ?? [],
    { ...(options.elimination ?? {}), chart },
  );

  const acquired = acquisitions(group, ledgers, options.acquisitions ?? [], {
    rates: options.rates,
    presentation,
    rounding,
  });

  const entries: JournalEntry[] = [];

  // ------------------------------------------- 1. each entity's own position
  for (const contribution of aggregation.entities) {
    const postings: PostingInput[] = contribution.translation.rows
      .filter((row) => !row.presentation.isZero)
      .map((row) => ({
        account: row.account,
        amount: row.presentation,
        memo: `${contribution.entity} ${row.basis}`,
      }));
    if (!contribution.translationAdjustment.isZero) {
      postings.push({
        account: GROUP_ACCOUNTS.translationReserve,
        amount: contribution.translationAdjustment,
        memo: `${contribution.entity} translated from ${contribution.functional.code}`,
      });
    }
    if (postings.length === 0) continue;
    entries.push(
      JournalEntry.create(
        {
          id: `TB-${contribution.entity}`,
          date: aggregation.asAt,
          narration: `${group.get(contribution.entity).name} — trial balance, restated`,
          postings,
          tags: ["consolidation", "entity"],
        },
        chart,
      ),
    );
  }

  // ---------------------------------------------------- 2. the eliminations
  entries.push(...eliminations.entries);

  // ------------------------------- 3 and 4. investment, goodwill, the outside stake
  const workings: SubsidiaryWorking[] = [];
  for (const acquisition of acquired) {
    const entity = group.get(acquisition.entity);
    const equityRows = (
      aggregation.entities.find((c) => c.entity === entity.code)?.translation.rows ?? []
    ).filter((row) => row.type === "equity" && !row.presentation.isZero);
    const equityRemoved = equityRows.reduce((running, row) => running.plus(row.presentation), zero);
    const netAssetsNow = sumRows(aggregation, entity.code, ["asset", "liability", null]);
    const profitForPeriod = sumRows(aggregation, entity.code, ["income", "expense"]).negated();
    const nci = entity.nonControlling;
    const nciProfitShare = nci.share(profitForPeriod, rounding);
    const nciClosing = nci.share(netAssetsNow, rounding).plus(acquisition.nciGoodwill);

    const postings: PostingInput[] = equityRows.map((row) => ({
      account: row.account,
      amount: row.presentation.negated(),
      memo: `${entity.code} pre-acquisition and reserves, removed`,
    }));
    // Goodwill is an asset; a bargain purchase is a gain. One posting either way.
    if (!acquisition.goodwill.isZero) {
      postings.push({
        account: GROUP_ACCOUNTS.goodwill,
        amount: acquisition.goodwill,
        memo: `on the acquisition of ${entity.code}`,
      });
    }
    if (!acquisition.bargainGain.isZero) {
      postings.push({
        account: GROUP_ACCOUNTS.bargainGain,
        amount: acquisition.bargainGain.negated(),
        memo: `${entity.code} cost less than the net assets it brought`,
      });
    }
    if (!acquisition.consideration.isZero) {
      postings.push({
        account: acquisition.investmentAccount,
        amount: acquisition.consideration.negated(),
        memo: `investment in ${entity.code}, eliminated`,
      });
    }
    const nciBroughtIn = nciClosing.minus(nciProfitShare);
    if (!nciBroughtIn.isZero) {
      postings.push({
        account: GROUP_ACCOUNTS.nonControllingInterest,
        amount: nciBroughtIn.negated(),
        memo: `${nci.toPercentString(4)} of ${entity.code}`,
      });
    }
    const balancing = postings
      .reduce((running, p) => running.plus(p.amount), zero)
      .negated();
    if (!balancing.isZero) {
      postings.push({
        account: "3200",
        amount: balancing,
        memo: `group share of ${entity.code}'s post-acquisition reserves`,
      });
    }
    entries.push(
      JournalEntry.create(
        {
          id: `CONS-${entity.code}`,
          date: aggregation.asAt,
          narration: `Eliminate the investment in ${entity.name} against its equity`,
          postings,
          tags: ["consolidation", "acquisition"],
        },
        chart,
      ),
    );

    if (!nciProfitShare.isZero) {
      entries.push(
        JournalEntry.create(
          {
            id: `NCI-${entity.code}`,
            date: aggregation.asAt,
            narration: `${nci.toPercentString(4)} of ${entity.name}'s result for the period`,
            postings: [
              {
                account: GROUP_ACCOUNTS.nciProfitShare,
                amount: nciProfitShare,
                memo: "out of the result attributable to the parent's owners",
              },
              {
                account: GROUP_ACCOUNTS.nonControllingInterest,
                amount: nciProfitShare.negated(),
                memo: "and into the outside stake",
              },
            ],
            tags: ["consolidation", "non-controlling-interest"],
          },
          chart,
        ),
      );
    }

    workings.push(
      Object.freeze({
        entity: entity.code,
        acquisition,
        equityRemoved,
        netAssetsNow,
        profitForPeriod,
        nciProfitShare,
        nciClosing,
        postAcquisitionReserves: balancing.negated(),
      }),
    );
  }

  const ledger = Ledger.from(entries, chart);
  const tb = trialBalance(ledger, { currency: presentation, asAt: aggregation.asAt });

  const balanceOf = (code: string): Money => ledger.balanceOf(code, presentation);

  return Object.freeze({
    group,
    presentation,
    asAt: aggregation.asAt,
    period: aggregation.period,
    aggregation,
    eliminations,
    workings: Object.freeze(workings),
    ledger,
    chart,
    trialBalance: tb,
    goodwill: balanceOf(GROUP_ACCOUNTS.goodwill),
    bargainGain: sumMoney(
      workings.map((w) => w.acquisition.bargainGain),
      presentation,
    ),
    nonControllingInterest: balanceOf(GROUP_ACCOUNTS.nonControllingInterest).negated(),
    translationReserve: balanceOf(GROUP_ACCOUNTS.translationReserve).negated(),
    investmentResidual: balanceOf(GROUP_ACCOUNTS.investment),
    residual: equationResidual(ledger, { currency: presentation, asAt: aggregation.asAt }),
    balanced: tb.balanced,
  });
}

export function renderConsolidation(result: Consolidation): string {
  const lines: string[] = [];
  const label = (text: string, amount: Money): string =>
    `  ${text.padEnd(48)}${amount.toDecimalString().padStart(16)}`;
  lines.push(
    `${result.group.name} — consolidated as at ${result.asAt} in ${result.presentation.code}`,
  );
  lines.push(
    `${result.group.consolidated().length} entities consolidated, ` +
      `${result.eliminations.pairs.length} intercompany ${
        result.eliminations.pairs.length === 1 ? "pair" : "pairs"
      } eliminated, ` +
      `${result.ledger.size} entries.`,
  );
  lines.push("");
  for (const working of result.workings) {
    lines.push(
      `${working.entity} — ${result.group.get(working.entity).name}, ` +
        `${working.acquisition.groupInterest.toPercentString(4)} to the group`,
    );
    lines.push(label("Goodwill", working.acquisition.goodwill));
    lines.push(label("Net assets now", working.netAssetsNow));
    lines.push(label("Result for the period", working.profitForPeriod));
    if (!working.acquisition.nonControllingInterest.isZero) {
      lines.push(label("Outside stake's share of the result", working.nciProfitShare));
      lines.push(label("Outside stake at the reporting date", working.nciClosing));
    }
    lines.push(label("Group's post-acquisition reserves", working.postAcquisitionReserves));
    lines.push("");
  }
  lines.push("The group");
  lines.push(label("Goodwill", result.goodwill));
  if (!result.bargainGain.isZero) lines.push(label("Gain on a bargain purchase", result.bargainGain));
  lines.push(label("Non-controlling interest", result.nonControllingInterest));
  lines.push(label("Translation reserve", result.translationReserve));
  if (!result.investmentResidual.isZero) {
    lines.push(
      label("Investment left uneliminated", result.investmentResidual) +
        "  <- the books carry it at something other than what was paid",
    );
  }
  if (!result.eliminations.totalDifference.isZero) {
    lines.push(label("Intercompany differences in transit", result.eliminations.totalDifference));
  }
  lines.push(label("Accounting equation residual", result.residual));
  if (!result.balanced) {
    lines.push("THE CONSOLIDATED LEDGER DOES NOT BALANCE");
  }
  for (const item of result.eliminations.unmatched) {
    lines.push(`Unpaired: ${item.side.entity} ${item.side.account} — ${item.reason}`);
  }
  return lines.join("\n");
}
