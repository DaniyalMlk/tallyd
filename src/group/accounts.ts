/**
 * The accounts a consolidation needs and no single company's books have.
 *
 * Every line here exists only at the group level. Goodwill is the difference
 * between what was paid for a subsidiary and what its net assets were worth,
 * which is a fact about the acquisition and not about the subsidiary — its own
 * balance sheet has never heard of it. The non-controlling interest is a claim
 * by people who are not the group's shareholders on companies the group
 * controls, which cannot exist until more than one company is on the page. The
 * translation reserve holds the residual of restating books kept in another
 * currency. Items in transit is where an intercompany balance that does not
 * agree with its mirror goes: a real asset of the group, usually money already
 * sent and not yet arrived, and a line a reader can question rather than a
 * plug hidden inside a total.
 *
 * The gain or loss on selling a subsidiary is a group figure for the same
 * reason goodwill is. The company that held the shares measures its gain
 * against what it paid for them; the group measures the same sale against the
 * net assets that walked out of the door and the goodwill that has to come off
 * with them, and the two figures agree only by accident. Two accounts rather
 * than one signed account, because a loss is an expense and belongs in the
 * expenses, the same way a bargain purchase is a gain and not negative
 * goodwill.
 *
 * Impairment of goodwill is a group line because goodwill is: nothing in the
 * subsidiary's own books says the price the group paid over its net assets has
 * stopped being worth paying. It is an expense rather than a reduction of the
 * asset shown net, because a reader who wants to know what the group wrote off
 * this year should not have to difference two balance sheets to find out.
 *
 * Unrealised profit on intragroup stock is a group line for a subtler reason:
 * nothing is wrong in either company's books. The seller earned its margin and
 * recorded it; the buyer paid the price and carries the goods at it. It is only
 * on one page together that the two become a company having sold something to
 * itself at a profit, and the margin has to come back out of the stock it is
 * sitting inside. Charged to its own expense rather than folded into cost of
 * sales, because a reader who wants to know what the group's third-party gross
 * margin was should not have to take this out again by hand.
 *
 * The intercompany accounts themselves are different in kind: those belong in
 * the entities' own books, and they are here so the standard chart has them to
 * post to. A group that lends between its companies needs somewhere to record
 * it, and one account per counterparty is the shape that lets the two sides be
 * paired at the close.
 */

import type { AccountDefinition } from "../accounts/chart.js";
import { ChartOfAccounts } from "../accounts/chart.js";
import type { Currency } from "../money/currency.js";
import { STANDARD_ACCOUNTS } from "../accounts/standard.js";

/** Codes referred to by name elsewhere in the consolidation. */
export const GROUP_ACCOUNTS = {
  intercompanyReceivable: "1190",
  itemsInTransit: "1195",
  investment: "1230",
  goodwill: "1290",
  intercompanyPayable: "2190",
  translationReserve: "3250",
  nonControllingInterest: "3400",
  intercompanySales: "4950",
  bargainGain: "4960",
  intercompanyPurchases: "5960",
  nciProfitShare: "3410",
  disposalGain: "4970",
  disposalLoss: "5970",
  unrealisedProfit: "5965",
  goodwillImpairment: "5975",
} as const;

export const CONSOLIDATION_ACCOUNTS: readonly AccountDefinition[] = [
  {
    code: GROUP_ACCOUNTS.intercompanyReceivable,
    name: "Owed by Group Companies",
    type: "asset",
    parent: "1100",
    description: "One account per counterparty, so the two sides can be paired",
  },
  {
    code: GROUP_ACCOUNTS.itemsInTransit,
    name: "Items in Transit",
    type: "asset",
    parent: "1100",
    description: "Where an intercompany balance that does not agree with its mirror lands",
  },
  {
    code: GROUP_ACCOUNTS.investment,
    name: "Investments in Subsidiaries",
    type: "asset",
    parent: "1200",
    description: "What the parent paid; eliminated against the subsidiary's equity",
  },
  {
    code: GROUP_ACCOUNTS.goodwill,
    name: "Goodwill",
    type: "asset",
    parent: "1200",
    description: "Consideration over the net assets acquired; exists only in the group",
  },
  {
    code: GROUP_ACCOUNTS.intercompanyPayable,
    name: "Owed to Group Companies",
    type: "liability",
    parent: "2000",
  },
  {
    code: GROUP_ACCOUNTS.translationReserve,
    name: "Translation Reserve",
    type: "equity",
    parent: "3000",
    description: "The accumulated residual of restating books kept in another currency",
  },
  {
    code: GROUP_ACCOUNTS.nonControllingInterest,
    name: "Non-controlling Interest",
    type: "equity",
    parent: "3000",
    description: "The claim of shareholders outside the group on companies inside it",
  },
  {
    code: GROUP_ACCOUNTS.intercompanySales,
    name: "Intercompany Sales",
    type: "income",
    parent: "4000",
    description: "Kept apart from third-party revenue so it can be taken back out",
  },
  {
    code: GROUP_ACCOUNTS.intercompanyPurchases,
    name: "Intercompany Purchases",
    type: "expense",
    parent: "5000",
  },
  {
    code: GROUP_ACCOUNTS.unrealisedProfit,
    name: "Unrealised Profit on Intragroup Stock",
    type: "expense",
    parent: "5000",
    description: "Margin the group charged itself on goods still in its own stock",
  },
  {
    code: GROUP_ACCOUNTS.nciProfitShare,
    name: "Profit Attributable to Non-controlling Interest",
    type: "equity",
    parent: "3000",
    description: "An allocation of the group's result, not a cost of earning it",
  },
  {
    code: GROUP_ACCOUNTS.bargainGain,
    name: "Gain on a Bargain Purchase",
    type: "income",
    parent: "4000",
    description: "Net assets acquired above what was paid for them",
  },
  {
    code: GROUP_ACCOUNTS.goodwillImpairment,
    name: "Impairment of Goodwill",
    type: "expense",
    parent: "5000",
    description: "What the group has written off the price it paid over the net assets",
  },
  {
    code: GROUP_ACCOUNTS.disposalGain,
    name: "Gain on Disposal of a Subsidiary",
    type: "income",
    parent: "4000",
    description: "Proceeds above what the group was carrying the company at",
  },
  {
    code: GROUP_ACCOUNTS.disposalLoss,
    name: "Loss on Disposal of a Subsidiary",
    type: "expense",
    parent: "5000",
    description: "What the group was carrying the company at, above the proceeds",
  },
];

/**
 * The standard chart with the group accounts added.
 *
 * Consolidated statements are prepared on this, and so are the books of an
 * entity that trades with the rest of the group.
 */
export function groupChart(currency: Currency | string = "GBP"): ChartOfAccounts {
  return ChartOfAccounts.build([...STANDARD_ACCOUNTS, ...CONSOLIDATION_ACCOUNTS], { currency });
}
