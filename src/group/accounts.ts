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
  intercompanyPurchases: "5960",
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
