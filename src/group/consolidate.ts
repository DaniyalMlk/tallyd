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
 * Five kinds of entry go in, in order.
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
 * 5. **One per company the group sold during the period**, taking back off the
 *    closing position the first three entries have just put on. A company sold
 *    in September is consolidated as at September — eight months of results and
 *    the balance sheet it had on the day — and then that balance sheet, its
 *    goodwill and the outside stake's claim on it are removed in one step. The
 *    results stay. What falls out as the balancing figure is the group's gain
 *    or loss on the sale, and it comes to exactly
 *    `proceeds - (net assets - the outside stake + goodwill)`, which the tests
 *    check rather than assume.
 *
 * The non-controlling interest's claim is computed as its share of the net
 * assets now, plus whatever goodwill was attributed to it at acquisition. That
 * needs no roll-forward from one period to the next and so cannot drift, which
 * a schedule of movements can.
 *
 * One assumption is worth stating outright, because it is inherited from the
 * translation and is easy to walk past: the income and expense balances in an
 * entity's trial balance are taken to be the reporting period's result. That
 * is true of books closed to retained earnings at each year end and false of
 * books that have never been closed, where the profit and loss accounts have
 * been accumulating since the company was formed. Such books would be
 * translated at this period's average rate and would hand the outside stake a
 * share of every year's profit at once.
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
import { type Disposal, type DisposalInput, disposals } from "./disposal.js";
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

/** A company that left the group, and what removing it did. */
export interface DisposalWorking {
  readonly entity: string;
  readonly disposal: Disposal;
  /** The assets and liabilities taken back off the group's balance sheet. */
  readonly netAssetsRemoved: Money;
  /** The outside stake's claim removed with them. */
  readonly nciRemoved: Money;
  /** The goodwill that went with the company. */
  readonly goodwillRemoved: Money;
  /**
   * The balancing figure on the disposal entry, credit-positive. Equal to
   * `proceeds - carrying amount` by construction, which is asserted rather
   * than assumed.
   */
  readonly result: Money;
  /** The entity's result for the part of the period it was still the group's. */
  readonly resultToDisposal: Money;
}

export interface Consolidation {
  readonly group: GroupStructure;
  readonly presentation: Currency;
  readonly asAt: CalendarDate;
  readonly period: DateRange;
  readonly aggregation: Aggregation;
  readonly eliminations: Eliminations;
  readonly workings: readonly SubsidiaryWorking[];
  readonly disposals: readonly DisposalWorking[];
  /** The gain on companies sold during the period, less the losses. */
  readonly disposalResult: Money;
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
  /**
   * What the disposal accounts carry over and above the group's own gain,
   * credit-positive. Nil when the proceeds the consolidation was told about are
   * the proceeds the holder's books recorded; anything else means the two
   * disagree about the same sale, and the difference is sitting in the income
   * statement looking like a result.
   */
  readonly disposalResidual: Money;
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
  disposals?: readonly DisposalInput[];
  /** Where an entity's pre-acquisition result goes. Retained earnings by default. */
  reserves?: string;
  /**
   * Consolidate an entity acquired part-way through the period for the whole of
   * it anyway. Off by default, and wrong; it exists so that the difference can
   * be shown rather than described.
   */
  wholePeriodRegardless?: boolean;
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

  // The investment accounts are held at the rate on the day the shares were
  // bought. A euro investment retranslated at the closing rate would fail to
  // eliminate against the price that was paid for it, and the shortfall would
  // sit in the consolidated balance sheet looking like an investment in a
  // company nobody could name.
  const investmentAccounts = new Set<string>([
    GROUP_ACCOUNTS.investment,
    ...(options.acquisitions ?? []).map((a) => a.investmentAccount ?? GROUP_ACCOUNTS.investment),
  ]);
  const aggregationOptions: AggregationOptions = {
    rates: options.rates,
    asAt: options.asAt,
    ...(options.period === undefined ? {} : { period: options.period }),
    ...(options.averageMethod === undefined ? {} : { averageMethod: options.averageMethod }),
    ...(options.equityBasis === undefined ? {} : { equityBasis: options.equityBasis }),
    historicalAccounts: [...investmentAccounts],
    ...(options.reserves === undefined ? {} : { reserves: options.reserves }),
    ...(options.wholePeriodRegardless === undefined
      ? {}
      : { wholePeriodRegardless: options.wholePeriodRegardless }),
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

  // An entity the aggregation left out — an associate, or a company sold
  // before this period opened — has no equity on the page to eliminate an
  // investment against, so its acquisition is not accounted for here either.
  const contributed = new Set(aggregation.entities.map((c) => c.entity));

  // The net assets of each entity as this consolidation carries them, so that
  // a disposal removes exactly what was added rather than something measured
  // again from the same books by a different route.
  const netAssetsByEntity = new Map<string, Money>(
    aggregation.entities.map((c) => [
      c.entity,
      sumRows(aggregation, c.entity, ["asset", "liability", null]),
    ]),
  );
  const sold = disposals(
    group,
    ledgers,
    (options.disposals ?? []).filter((input) => contributed.has(input.entity)),
    acquired,
    { rates: options.rates, presentation, rounding, netAssetsAsConsolidated: netAssetsByEntity },
  );

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
    if (!contributed.has(acquisition.entity)) continue;
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

  // -------------------------------------------- 5. the companies that have gone
  //
  // Everything above has just consolidated a company the group no longer owns,
  // as at the day it went: its balance sheet is on the page, its goodwill has
  // been recognised, and the outside stake has a claim on it. All three have to
  // come back off, and what falls out of taking them off is the gain.
  //
  // Two of the postings are undoings rather than removals, and they are there
  // because the holding company's own books have already recorded the sale.
  // The investment is put back because the elimination above credited an
  // account the holder no longer carries anything in; and the holder's own gain
  // is reversed because it is measured against what the shares cost, which is
  // not what the group is giving up.
  const disposalWorkings: DisposalWorking[] = [];
  for (const disposal of sold) {
    const entity = group.get(disposal.entity);
    const rows = (
      aggregation.entities.find((c) => c.entity === entity.code)?.translation.rows ?? []
    ).filter(
      (row) =>
        (row.type === "asset" || row.type === "liability" || row.type === null) &&
        !row.presentation.isZero,
    );
    const postings: PostingInput[] = rows.map((row) => ({
      account: row.account,
      amount: row.presentation.negated(),
      memo: `${entity.code} at ${disposal.disposed}, out with the company`,
    }));
    if (!disposal.goodwillDerecognised.isZero) {
      postings.push({
        account: GROUP_ACCOUNTS.goodwill,
        amount: disposal.goodwillDerecognised.negated(),
        memo: `nothing left for the goodwill on ${entity.code} to attach to`,
      });
    }
    if (!disposal.nciAtDisposal.isZero) {
      postings.push({
        account: GROUP_ACCOUNTS.nonControllingInterest,
        amount: disposal.nciAtDisposal,
        memo: `the outside stake's claim on ${entity.code} goes with it`,
      });
    }
    const consideration = disposal.proceeds.minus(disposal.holderResult);
    if (!consideration.isZero) {
      postings.push({
        account: disposal.investmentAccount,
        amount: consideration,
        memo: `${entity.code} is no longer on the holder's books at what was paid for it`,
      });
    }
    if (!disposal.holderResult.isZero) {
      postings.push({
        account: disposal.holderAccount,
        amount: disposal.holderResult,
        memo: `what the holder made on ${entity.code} against the cost of the shares, reversed`,
      });
    }
    const balancing = postings.reduce((running, p) => running.plus(p.amount), zero).negated();
    if (!balancing.isZero) {
      postings.push({
        account: disposal.account,
        amount: balancing,
        memo: `proceeds of ${disposal.proceeds.toDecimalString()} against a carrying amount of ${disposal.carryingAmount.toDecimalString()}`,
      });
    }
    if (postings.length > 0) {
      entries.push(
        JournalEntry.create(
          {
            id: `DISP-${entity.code}`,
            date: aggregation.asAt,
            narration: `Remove ${entity.name}, disposed of ${disposal.disposed}`,
            postings,
            tags: ["consolidation", "disposal"],
          },
          chart,
        ),
      );
    }
    disposalWorkings.push(
      Object.freeze({
        entity: entity.code,
        disposal,
        netAssetsRemoved: rows.reduce((running, row) => running.plus(row.presentation), zero),
        nciRemoved: disposal.nciAtDisposal,
        goodwillRemoved: disposal.goodwillDerecognised,
        result: balancing.negated(),
        resultToDisposal: sumRows(aggregation, entity.code, ["income", "expense"]).negated(),
      }),
    );
  }

  const ledger = Ledger.from(entries, chart);
  const tb = trialBalance(ledger, { currency: presentation, asAt: aggregation.asAt });

  const balanceOf = (code: string): Money => ledger.balanceOf(code, presentation);

  const disposalResult = sumMoney(
    disposalWorkings.map((w) => w.result),
    presentation,
  );
  // The disposal accounts should end up carrying the group's gain and nothing
  // else: the holder's own figure went in from its trial balance and came
  // straight back out. A residue means the proceeds this consolidation was
  // given are not the proceeds the holder's books recorded — the same sale
  // described two ways, with the difference left in the income statement.
  const disposalAccounts = new Set(
    disposalWorkings.flatMap((w) => [w.disposal.account, w.disposal.holderAccount]),
  );
  const disposalResidual = sumMoney(
    [...disposalAccounts].map((code) => balanceOf(code)),
    presentation,
  )
    .plus(disposalResult)
    .negated();

  return Object.freeze({
    group,
    presentation,
    asAt: aggregation.asAt,
    period: aggregation.period,
    aggregation,
    eliminations,
    workings: Object.freeze(workings),
    disposals: Object.freeze(disposalWorkings),
    disposalResult,
    disposalResidual,
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
    const contribution = result.aggregation.entities.find((c) => c.entity === working.entity);
    const control = contribution?.control;
    if (control?.acquiredDuring === true && control.window !== null) {
      lines.push(
        contribution?.windowApplied === true
          ? `  Consolidated from ${control.window.from}, not from ${control.period.from}: ` +
            `${control.reason}.`
          : `  ${control.reason} — and consolidated for the whole of it anyway, ` +
            `because that is what was asked for.`,
      );
      // In the entity's own currency, not the group's: it is a figure read off
      // that company's books, and translating it would need a rate for a
      // period the group was not there for.
      const before = contribution?.preAcquisitionResult;
      if (before !== undefined && contribution?.windowApplied === true) {
        lines.push(
          label(`Earned before the group controlled it (${before.currency.code})`, before),
        );
      }
    }
    // For a company the group still holds, these are figures at the reporting
    // date. For one it sold they are figures at the date it went, and saying
    // "now" about them would be saying something untrue about a company the
    // group does not own.
    const readAt = contribution?.readAt;
    const gone = control?.disposedDuring === true;
    lines.push(label("Goodwill", working.acquisition.goodwill));
    lines.push(label(gone ? `Net assets at ${readAt}` : "Net assets now", working.netAssetsNow));
    lines.push(label("Result for the period", working.profitForPeriod));
    if (!working.acquisition.nonControllingInterest.isZero) {
      lines.push(label("Outside stake's share of the result", working.nciProfitShare));
      lines.push(
        label(
          gone ? `Outside stake at ${readAt}` : "Outside stake at the reporting date",
          working.nciClosing,
        ),
      );
    }
    lines.push(label("Group's post-acquisition reserves", working.postAcquisitionReserves));
    lines.push("");
  }
  for (const working of result.disposals) {
    const disposal = working.disposal;
    lines.push(
      `${working.entity} — ${result.group.get(working.entity).name}, ` +
        `disposed of ${disposal.disposed}`,
    );
    lines.push(
      `  Consolidated to ${disposal.disposed} and then removed: the group's result includes ` +
        `what it earned up to that day and its balance sheet none of what it owned.`,
    );
    lines.push(label("Result while it was still the group's", working.resultToDisposal));
    lines.push(label("Net assets removed", working.netAssetsRemoved.negated()));
    if (!working.nciRemoved.isZero) {
      lines.push(label("  outside stake's claim removed with them", working.nciRemoved));
    }
    if (!working.goodwillRemoved.isZero) {
      lines.push(label("Goodwill derecognised", working.goodwillRemoved.negated()));
    }
    lines.push(label("Proceeds", disposal.proceeds));
    lines.push(
      working.result.isNegative
        ? label("Loss on disposal", working.result.negated())
        : label("Gain on disposal", working.result),
    );
    lines.push("");
  }

  lines.push("The group");
  lines.push(label("Goodwill", result.goodwill));
  if (!result.bargainGain.isZero) lines.push(label("Gain on a bargain purchase", result.bargainGain));
  if (!result.disposalResult.isZero) {
    lines.push(
      result.disposalResult.isNegative
        ? label("Loss on disposals", result.disposalResult.negated())
        : label("Gain on disposals", result.disposalResult),
    );
  }
  lines.push(label("Non-controlling interest", result.nonControllingInterest));
  lines.push(label("Translation reserve", result.translationReserve));
  if (!result.investmentResidual.isZero) {
    lines.push(
      label("Investment left uneliminated", result.investmentResidual) +
        (result.disposals.length > 0
          ? "  <- a disposal assumes the holder's own books already record the sale"
          : "  <- the books carry it at something other than what was paid"),
    );
  }
  if (!result.disposalResidual.isZero) {
    lines.push(
      label("Left in the disposal accounts", result.disposalResidual) +
        "  <- the proceeds given are not the ones the holder's books recorded",
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
