/**
 * The two claims about intragroup stock, measured rather than asserted.
 *
 * Both are claims the README makes in prose, and prose is where an accounting
 * adjustment goes wrong without anybody noticing. So each is computed here
 * from a group small enough to work by hand, and the evidence gate reads the
 * figures back.
 *
 * The first is that the two rate conventions are not the same rate. One
 * consignment, one set of figures, two bases: a quarter on cost and a quarter
 * on price. If the conversion is right they differ by a fifth of the smaller
 * one, and the larger carries the goods below what they cost the group — which
 * is why reading one convention as the other is not a rounding question.
 *
 * The second is that the charge follows the seller. The same consignment is
 * run twice, once with the subsidiary selling up to its parent and once with
 * the parent selling down into the subsidiary, with every other figure
 * identical. The write-down against stock has to be the same both times and
 * the outside stake's share has to not be, and the pair of numbers is the only
 * way to say that without the reader taking it on trust.
 */

import { ChartOfAccounts } from "../accounts/chart.js";
import { STANDARD_ACCOUNTS } from "../accounts/standard.js";
import { CONSOLIDATION_ACCOUNTS, GROUP_ACCOUNTS } from "../group/accounts.js";
import { JournalEntry } from "../ledger/entry.js";
import { Ledger } from "../ledger/ledger.js";
import { dateRange } from "../ledger/date.js";
import { GBP } from "../money/currency.js";
import { Money } from "../money/money.js";
import { RateTable } from "../fx/table.js";
import { GroupStructure } from "../group/structure.js";
import { Interest } from "../group/interest.js";
import { consolidate, type Consolidation } from "../group/consolidate.js";
import type { IntragroupStockDeclaration } from "../group/unrealised.js";

/** The holder's stock account. The standard chart has none, so one is added. */
const STOCK = "1160";

const CHART = ChartOfAccounts.build(
  [
    ...STANDARD_ACCOUNTS,
    ...CONSOLIDATION_ACCOUNTS,
    { code: STOCK, name: "Inventory", type: "asset", parent: "1100" },
  ],
  { currency: "GBP" },
);

const RATES = RateTable.of([{ date: "2026-12-31", base: "EUR", quote: "GBP", rate: "0.8000" }], {
  maxStaleDays: 400,
});
const PERIOD = dateRange("2026-01-01", "2026-12-31");
const ASAT = "2026-12-31";

/** P owns three quarters of S. */
const GROUP = GroupStructure.build(
  [
    { code: "P", name: "Parent Ltd", currency: GBP },
    { code: "S", name: "Sub Ltd", currency: GBP, parent: "P", holding: "75" },
  ],
  { presentation: "GBP" },
);

const gbp = (text: string): Money => Money.parse(text, GBP);

interface Leg {
  id: string;
  date: string;
  narration: string;
  debit: string;
  credit: string;
  amount: string;
}

function ledgerOf(legs: readonly Leg[]): Ledger {
  return Ledger.from(
    legs.map((leg) => JournalEntry.simple({ ...leg, amount: gbp(leg.amount) }, CHART)),
    CHART,
  );
}

/**
 * One consignment: 100,000 of goods that cost the seller 80,000, all still in
 * the buyer's stock. `sellerIsSub` swaps which way the goods went and changes
 * nothing else.
 */
function books(sellerIsSub: boolean): { P: Ledger; S: Ledger; seller: string; buyer: string } {
  const seller = sellerIsSub ? "S" : "P";
  const buyer = sellerIsSub ? "P" : "S";
  const pLegs: Leg[] = [
    { id: "P-CAP", date: "2026-01-01", narration: "Capital", debit: "1110", credit: "3100", amount: "400000.00" },
    { id: "P-INV", date: "2026-01-01", narration: "Investment in S", debit: "1230", credit: "1110", amount: "90000.00" },
  ];
  const sLegs: Leg[] = [
    { id: "S-CAP", date: "2026-01-01", narration: "Capital", debit: "1110", credit: "3100", amount: "100000.00" },
  ];
  const sellerLegs = seller === "P" ? pLegs : sLegs;
  const buyerLegs = buyer === "P" ? pLegs : sLegs;
  sellerLegs.push(
    { id: `${seller}-BUY`, date: "2026-06-01", narration: "Goods in", debit: STOCK, credit: "1110", amount: "80000.00" },
    { id: `${seller}-SELL`, date: "2026-06-30", narration: `Goods to ${buyer}`, debit: "1190", credit: "4950", amount: "100000.00" },
    { id: `${seller}-COS`, date: "2026-06-30", narration: "Cost", debit: "5100", credit: STOCK, amount: "80000.00" },
  );
  buyerLegs.push({
    id: `${buyer}-RECV`,
    date: "2026-06-30",
    narration: `Goods from ${seller}`,
    debit: STOCK,
    credit: "2190",
    amount: "100000.00",
  });
  return { P: ledgerOf(pLegs), S: ledgerOf(sLegs), seller, buyer };
}

function consolidated(
  sellerIsSub: boolean,
  stock: readonly IntragroupStockDeclaration[],
): Consolidation {
  const { P, S, seller, buyer } = books(sellerIsSub);
  return consolidate(
    GROUP,
    { P, S },
    {
      rates: RATES,
      asAt: ASAT,
      period: PERIOD,
      acquisitions: [{ entity: "S", acquired: "2026-01-01", consideration: gbp("90000.00") }],
      intercompany: [
        { entity: seller, account: "1190", counterparty: buyer, link: "trading" },
        { entity: buyer, account: "2190", counterparty: seller, link: "trading" },
      ],
      intragroupStock: stock,
    },
  );
}

function declaration(
  sellerIsSub: boolean,
  basis: "markup-on-cost" | "margin-on-price",
): IntragroupStockDeclaration {
  return {
    seller: sellerIsSub ? "S" : "P",
    holder: sellerIsSub ? "P" : "S",
    account: STOCK,
    onHand: gbp("100000.00"),
    basis,
    rate: Interest.of(1n, 4n),
  };
}

export interface UnrealisedEvidence {
  /** The transfer price of the stock still on hand. */
  readonly onHand: string;
  /** What the goods cost the group. */
  readonly cost: string;
  /** The provision under each convention, from the same quarter. */
  readonly onCost: string;
  readonly onPrice: string;
  /** What the stock is carried at under the wrong convention. */
  readonly carriedOnPrice: string;
  /** Stock written off when the subsidiary sold, and when the parent did. */
  readonly stockDownSubSold: string;
  readonly stockDownParentSold: string;
  /** The outside stake's share in each direction. */
  readonly nciSubSold: string;
  readonly nciParentSold: string;
  readonly balancedBothWays: boolean;
}

export function unrealisedEvidence(): UnrealisedEvidence {
  const onHand = gbp("100000.00");
  const cost = gbp("80000.00");

  // The same quarter, read two ways.
  const onCost = consolidated(true, [declaration(true, "markup-on-cost")]);
  const onPrice = consolidated(true, [declaration(true, "margin-on-price")]);

  // The same consignment, sent the other way.
  const parentSold = consolidated(false, [declaration(false, "markup-on-cost")]);
  const noProvision = consolidated(true, []);
  const noProvisionDown = consolidated(false, []);

  const stockOf = (result: Consolidation): Money => result.ledger.balanceOf(STOCK, GBP);

  return {
    onHand: onHand.toDecimalString(),
    cost: cost.toDecimalString(),
    onCost: onCost.unrealisedProfit.totalProvision.toDecimalString(),
    onPrice: onPrice.unrealisedProfit.totalProvision.toDecimalString(),
    carriedOnPrice: onHand.minus(onPrice.unrealisedProfit.totalProvision).toDecimalString(),
    stockDownSubSold: stockOf(noProvision).minus(stockOf(onCost)).toDecimalString(),
    stockDownParentSold: stockOf(noProvisionDown).minus(stockOf(parentSold)).toDecimalString(),
    nciSubSold: onCost.unrealisedProfit.totalNciShare.toDecimalString(),
    nciParentSold: parentSold.unrealisedProfit.totalNciShare.toDecimalString(),
    balancedBothWays: onCost.balanced && parentSold.balanced && onPrice.balanced,
  };
}

/**
 * The gate. Each check is the claim the README makes, in the direction that
 * would fail if the adjustment were wrong.
 */
export function checkUnrealised(figures: UnrealisedEvidence = unrealisedEvidence()): void {
  if (!figures.balancedBothWays) {
    throw new Error("a consolidation carrying the provision does not balance");
  }
  // A quarter on cost is a fifth of the price: 20,000 of the 100,000.
  if (figures.onCost !== "20000.00") {
    throw new Error(`a quarter on cost provided ${figures.onCost}, not 20000.00`);
  }
  if (figures.onPrice !== "25000.00") {
    throw new Error(`a quarter on price provided ${figures.onPrice}, not 25000.00`);
  }
  // And the wrong one carries the goods below what they cost the group, which
  // is the error being corrected, in the other direction and the same size.
  if (figures.carriedOnPrice !== "75000.00" || figures.cost !== "80000.00") {
    throw new Error(
      `the wrong convention carries the stock at ${figures.carriedOnPrice} ` +
        `against a cost of ${figures.cost}`,
    );
  }
  // The write-down is the same whichever way the goods went.
  if (figures.stockDownSubSold !== figures.stockDownParentSold) {
    throw new Error(
      `the stock fell by ${figures.stockDownSubSold} one way and ` +
        `${figures.stockDownParentSold} the other`,
    );
  }
  // The attribution is not: a quarter of it when the subsidiary sold, none of
  // it when the parent did.
  if (figures.nciSubSold !== "5000.00") {
    throw new Error(`the outside stake bore ${figures.nciSubSold}, not 5000.00`);
  }
  if (figures.nciParentSold !== "0.00") {
    throw new Error(
      `the outside stake bore ${figures.nciParentSold} of a margin its company never made`,
    );
  }
}

/** The README's row, and the figures behind it. */
export function unrealisedRows(figures: UnrealisedEvidence = unrealisedEvidence()): {
  readonly conventions: string;
  readonly attribution: string;
  readonly spelled: readonly string[];
} {
  return {
    conventions:
      `${figures.onCost} and ${figures.onPrice} on the same ${figures.onHand} of stock, ` +
      `the second carrying goods that cost ${figures.cost} at ${figures.carriedOnPrice}`,
    attribution:
      `stock down ${figures.stockDownSubSold} either way; the outside quarter bears ` +
      `${figures.nciSubSold} when its company sold and ${figures.nciParentSold} when it ` +
      `only bought`,
    spelled: [
      `   unrealised profit: ${figures.onHand} on hand, cost ${figures.cost}`,
      `   a quarter on cost ${figures.onCost}, a quarter on price ${figures.onPrice}`,
      `   stock written down ${figures.stockDownSubSold} (sub sold) and ` +
        `${figures.stockDownParentSold} (parent sold)`,
      `   outside stake bore ${figures.nciSubSold} and ${figures.nciParentSold}`,
      `   charged to ${GROUP_ACCOUNTS.unrealisedProfit}, its own line`,
    ],
  };
}
