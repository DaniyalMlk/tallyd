/**
 * The margin on goods the group sold itself and has not sold on.
 *
 * Aggregation adds every controlled company in full and the elimination pass
 * removes the trading, so a sale from one group company to another leaves no
 * revenue and no purchase behind. What it leaves behind is the margin. The
 * seller charged more than the goods cost it, the buyer paid that price, and
 * if the buyer still has the goods at the reporting date then consolidated
 * stock is carried at what the group charged itself. The group has not sold
 * anything to anybody; it has moved goods between two of its own warehouses
 * and booked a profit on the journey.
 *
 * Nothing is wrong in either set of books, which is why this cannot be
 * inferred from them. The seller's accounts are right: it sold goods and made
 * a margin. The buyer's are right too: it bought stock and carries it at cost
 * to itself. The error exists only on the consolidated page, and only somebody
 * who knows the goods came from inside the group can say so. So this is a
 * declaration, the same way an intercompany balance is.
 *
 * Two things here are easy to get wrong and are the reason the module exists.
 *
 * **The rate is quoted two incompatible ways.** "Cost plus a quarter" and "a
 * quarter margin" are different trades. Goods costing 80 sold at cost plus a
 * quarter fetch 100 and carry 20 of profit — a fifth of the selling price, not
 * a quarter of it. Taking a quarter of the 100 would provide 25 against a
 * margin that was only ever 20, and would write the stock below what it cost
 * the group. Both forms are accepted, named, and converted exactly; the rate
 * is a rational and not a decimal, so a third stays a third.
 *
 * **The charge follows the seller, not the stock.** The provision is a
 * reversal of profit, and the profit belongs to whoever recorded it. When a
 * parent sells down into a subsidiary that outsiders own a quarter of, the
 * parent made the margin and the group's own shareholders bear all of the
 * provision — however much of the stock the subsidiary is holding. When the
 * subsidiary sells up to the parent, the subsidiary made the margin, and the
 * outside stake gives up its quarter of it. The stock sits in the other
 * company in both cases, which is what makes the asymmetry look wrong until
 * you ask whose profit is being taken away.
 *
 * Everything that cannot be eliminated is named instead of absorbed. A
 * provision larger than the account it is written against would carry stock at
 * a negative amount, which is not a smaller error than the one being fixed; a
 * declaration naming a company that is not consolidated has nothing to
 * eliminate against. Both are reported with the declaration that produced
 * them and neither is plugged into a total.
 */

import { Money, sumMoney } from "../money/money.js";
import type { Currency } from "../money/currency.js";
import type { ChartOfAccounts } from "../accounts/chart.js";
import type { RoundingMode } from "../money/rounding.js";
import { JournalEntry } from "../ledger/entry.js";
import type { Aggregation } from "./aggregate.js";
import { GROUP_ACCOUNTS } from "./accounts.js";
import { GroupError, type GroupStructure } from "./structure.js";
import { Interest } from "./interest.js";

/**
 * How the profit inside a transfer price was quoted.
 *
 * `markup-on-cost` is profit over cost: "cost plus 25%". `margin-on-price` is
 * profit over the selling price: "a 25% margin". `cost` states what the goods
 * cost the seller and lets the profit fall out of the difference, which is the
 * form that needs no conversion and the one the other two are checked against.
 */
export type ProfitBasis = "markup-on-cost" | "margin-on-price" | "cost";

/** Goods one group company sold another, still in stock at the reporting date. */
export interface IntragroupStockDeclaration {
  /** The company that made the sale, and whose profit the provision reverses. */
  seller: string;
  /** The company holding the goods, and whose stock is written down. */
  holder: string;
  /**
   * The holder's stock account. Required: there is no standard inventory code
   * to default to, and guessing one would write down an account nobody named.
   */
  account: string;
  /**
   * What the holder still has on hand, measured at the price the group charged
   * itself. Not the whole consignment — goods already sold outside the group
   * carry a margin the group has earned, and the provision is only against
   * what is left.
   */
  onHand: Money;
  basis: ProfitBasis;
  /**
   * The rate, for the two rate bases. A quarter is `Interest.of(1n, 4n)`, and
   * a rational rather than 0.25 so that a third of a price is exact.
   */
  rate?: Interest;
  /** What the goods cost the seller, for the `cost` basis. */
  cost?: Money;
  /** Carried through to the provision entry's narration. */
  note?: string;
}

/** One declaration, priced. */
export interface UnrealisedProfit {
  readonly seller: string;
  readonly holder: string;
  readonly account: string;
  readonly accountName: string;
  readonly basis: ProfitBasis;
  /** The stock on hand as declared, in the currency it was declared in. */
  readonly onHand: Money;
  /** The same, in the group's presentation currency. */
  readonly onHandPresentation: Money;
  /**
   * The share of the transfer price that is profit, whichever way the rate was
   * quoted. A quarter on cost comes out as a fifth here, and that conversion
   * is the point of holding it.
   */
  readonly profitFraction: Interest;
  /** The provision, in the presentation currency. */
  readonly provision: Money;
  /** The outside stake in the seller; the share of the provision it bears. */
  readonly nonControlling: Interest;
  readonly nciShare: Money;
  /** The provision less the outside stake's share. */
  readonly groupShare: Money;
  readonly note: string;
}

/** A declaration that could not be provided against, and why. */
export interface UnprovidedStock {
  readonly declaration: IntragroupStockDeclaration;
  readonly reason: string;
}

export interface UnrealisedProfitOptions {
  /** Chart the provision entries are validated against. */
  chart?: ChartOfAccounts;
  /** Where the charge goes. The group's own expense line by default. */
  chargeAccount?: string;
  /** Prefix for the generated entry ids. */
  idPrefix?: string;
  rounding?: RoundingMode;
}

export interface UnrealisedProfitProvision {
  readonly presentation: Currency;
  readonly items: readonly UnrealisedProfit[];
  readonly unprovided: readonly UnprovidedStock[];
  /** One entry per declaration provided against. */
  readonly entries: readonly JournalEntry[];
  readonly totalProvision: Money;
  /** The part of it the group's own shareholders bear. */
  readonly totalGroupShare: Money;
  /** The part the outside stakes bear, because their companies made the sale. */
  readonly totalNciShare: Money;
}

/**
 * The fraction of a transfer price that is profit.
 *
 * A markup is profit over cost, so a price of `cost * (1 + m)` carries
 * `cost * m` of profit and the fraction of the price is `m / (1 + m)`. With
 * `m = n/d` that is `n / (n + d)`, which is exact in integers and is the whole
 * reason the rate is a rational: a quarter markup is a fifth of the price, and
 * a third markup is a quarter of it, neither of which has a decimal expansion
 * that survives being multiplied by a number of pence.
 */
export function profitFractionOf(basis: ProfitBasis, rate: Interest): Interest {
  switch (basis) {
    case "markup-on-cost":
      return Interest.of(rate.numerator, rate.numerator + rate.denominator);
    case "margin-on-price":
      return rate;
    case "cost":
      throw new GroupError("The cost basis takes a cost, not a rate");
  }
}

interface HolderStock {
  readonly accountName: string;
  /** What the group's balance sheet carries the account at. */
  readonly carried: Money;
  readonly translate: (amount: Money) => Money;
}

function holderStock(
  aggregation: Aggregation,
  entity: string,
  account: string,
  rounding: RoundingMode,
): HolderStock | null {
  const contribution = aggregation.entities.find((c) => c.entity === entity);
  if (contribution === undefined) return null;
  const row = contribution.translation.rows.find((r) => r.account === account);
  const presentation = aggregation.presentation;
  // The provision is written against a row that has already been translated,
  // so it has to be translated the same way. Striking the two legs of one
  // adjustment at different rates would leave a residue in the translation
  // reserve that looks like a currency movement and is not one.
  const rate = row?.effectiveRate ?? contribution.translation.closingRate;
  return {
    accountName: row?.name ?? account,
    carried: row?.presentation ?? Money.zero(presentation),
    translate: (amount: Money): Money => {
      if (amount.currency.code === presentation.code) return amount;
      if (rate === null) {
        throw new GroupError(
          `No rate to restate a provision stated in ${amount.currency.code} against ` +
            `${entity}'s ${account}, which is held in ${contribution.functional.code}`,
        );
      }
      return rate.apply(amount, rounding);
    },
  };
}

/**
 * Price every declaration and produce the entries that provide against them.
 *
 * Each entry credits the holder's stock and debits the charge, with the
 * outside stake's share of the charge taken out of its claim rather than out
 * of the parent's owners' reserves. It balances by construction, so the
 * combined trial balance balances after it as it did before.
 */
export function provideForUnrealisedProfit(
  group: GroupStructure,
  aggregation: Aggregation,
  declarations: readonly IntragroupStockDeclaration[],
  options: UnrealisedProfitOptions = {},
): UnrealisedProfitProvision {
  const presentation = aggregation.presentation;
  const zero = Money.zero(presentation);
  const rounding = options.rounding ?? "half-even";
  const charge = options.chargeAccount ?? GROUP_ACCOUNTS.unrealisedProfit;
  const prefix = options.idPrefix ?? "PUP";

  const items: UnrealisedProfit[] = [];
  const unprovided: UnprovidedStock[] = [];
  /** What the group's balance sheet carries each stock account at. */
  const carried = new Map<string, Money>();

  for (const declaration of declarations) {
    const { seller, holder, account, basis } = declaration;
    if (seller === holder) {
      throw new GroupError(
        `${seller} cannot sell stock to itself (account ${account}); a company's own ` +
          `margin on its own goods is not unrealised`,
      );
    }
    if (!group.has(seller)) {
      throw new GroupError(`Stock declaration names ${seller} as seller, which is not in the group`);
    }
    if (!group.has(holder)) {
      throw new GroupError(`Stock declaration names ${holder} as holder, which is not in the group`);
    }
    if (declaration.onHand.isNegative) {
      throw new GroupError(
        `${holder} cannot hold a negative amount of ${seller}'s goods (${account})`,
      );
    }

    // What share of the price is profit, by whichever route the caller took.
    let profitFraction: Interest;
    let provisionFunctional: Money;
    if (basis === "cost") {
      if (declaration.cost === undefined) {
        throw new GroupError(`The cost basis needs a cost (${seller} into ${holder}, ${account})`);
      }
      if (!declaration.cost.sameCurrency(declaration.onHand)) {
        throw new GroupError(
          `The cost of ${seller}'s goods is in ${declaration.cost.currency.code} and the stock ` +
            `on hand is in ${declaration.onHand.currency.code}`,
        );
      }
      if (declaration.cost.greaterThan(declaration.onHand)) {
        throw new GroupError(
          `${seller} sold goods costing ${declaration.cost.toDecimalString()} for ` +
            `${declaration.onHand.toDecimalString()}, which is a loss and not an unrealised ` +
            `profit; stock carried below cost is a write-down and belongs in the seller's books`,
        );
      }
      provisionFunctional = declaration.onHand.minus(declaration.cost);
      // Held for reporting, so the two rate bases and this one are comparable.
      profitFraction = declaration.onHand.isZero
        ? Interest.none
        : Interest.of(provisionFunctional.minorUnits, declaration.onHand.minorUnits);
    } else {
      if (declaration.rate === undefined) {
        throw new GroupError(
          `The ${basis} basis needs a rate (${seller} into ${holder}, ${account})`,
        );
      }
      profitFraction = profitFractionOf(basis, declaration.rate);
      provisionFunctional = profitFraction.share(declaration.onHand, rounding);
    }

    const translation = holderStock(aggregation, holder, account, rounding);
    if (translation === null) {
      unprovided.push(
        Object.freeze({
          declaration,
          reason:
            `${holder} is not being consolidated, so there is no stock on the group's ` +
            `balance sheet to provide against`,
        }),
      );
      continue;
    }
    const provision = translation.translate(provisionFunctional);
    const onHandPresentation = translation.translate(declaration.onHand);
    carried.set(`${holder} ${account}`, translation.carried);

    // The charge follows the seller. The outside stake in the seller gives up
    // its share of a profit that was never earned; the outside stake in the
    // holder gives up nothing, because the holder never recorded the margin.
    const nonControlling = group.get(seller).nonControlling;
    const split = nonControlling.splitOf(provision, rounding);

    items.push(
      Object.freeze({
        seller,
        holder,
        account,
        accountName: translation.accountName,
        basis,
        onHand: declaration.onHand,
        onHandPresentation,
        profitFraction,
        provision,
        nonControlling,
        nciShare: split.mine,
        groupShare: split.theirs,
        note: declaration.note ?? "",
      }),
    );
  }

  items.sort((a, b) => {
    const bySeller = a.seller.localeCompare(b.seller);
    if (bySeller !== 0) return bySeller;
    const byHolder = a.holder.localeCompare(b.holder);
    if (byHolder !== 0) return byHolder;
    return a.account.localeCompare(b.account);
  });

  // Stock cannot be written below nothing. Checked against the total provided
  // against each account rather than one declaration at a time, because three
  // consignments sitting in the same account are one asset between them and
  // any one of them alone can look affordable.
  const providedPerAccount = new Map<string, Money>();
  for (const item of items) {
    const id = `${item.holder} ${item.account}`;
    providedPerAccount.set(id, (providedPerAccount.get(id) ?? zero).plus(item.provision));
  }
  const overprovided = new Set<string>();
  for (const [id, provided] of providedPerAccount) {
    if (provided.greaterThan(carried.get(id) ?? zero)) overprovided.add(id);
  }

  const provided: UnrealisedProfit[] = [];
  for (const item of items) {
    const id = `${item.holder} ${item.account}`;
    if (!overprovided.has(id)) {
      provided.push(item);
      continue;
    }
    unprovided.push(
      Object.freeze({
        declaration: {
          seller: item.seller,
          holder: item.holder,
          account: item.account,
          onHand: item.onHand,
          basis: item.basis,
          note: item.note,
        },
        reason:
          `${(providedPerAccount.get(id) as Money).toDecimalString()} of provision against ` +
          `${(carried.get(id) as Money).toDecimalString()} carried in ${item.holder}'s ` +
          `${item.account}; writing stock below nothing is not a smaller error than ` +
          `carrying it above cost`,
      }),
    );
  }

  const entries: JournalEntry[] = [];
  let sequence = 0;
  for (const item of provided) {
    if (item.provision.isZero) continue;
    sequence += 1;
    const postings = [
      {
        account: item.account,
        amount: item.provision.negated(),
        memo: `${item.holder}'s stock, back to what it cost the group`,
      },
      {
        account: charge,
        amount: item.groupShare,
        memo: `${item.seller}'s margin on goods still in the group`,
      },
    ];
    if (!item.nciShare.isZero) {
      postings.push({
        account: GROUP_ACCOUNTS.nonControllingInterest,
        amount: item.nciShare,
        memo: `${item.nonControlling.toPercentString(4)} of ${item.seller}, whose margin it was`,
      });
    }
    entries.push(
      JournalEntry.create(
        {
          id: `${prefix}-${String(sequence).padStart(3, "0")}`,
          date: aggregation.asAt,
          narration:
            `Provide against ${item.seller}'s margin in ${item.holder}'s stock` +
            (item.note === "" ? "" : ` — ${item.note}`),
          postings,
          tags: ["consolidation", "unrealised-profit"],
        },
        options.chart,
      ),
    );
  }

  return Object.freeze({
    presentation,
    items: Object.freeze(provided),
    unprovided: Object.freeze(unprovided),
    entries: Object.freeze(entries),
    totalProvision: sumMoney(
      provided.map((i) => i.provision),
      presentation,
    ),
    totalGroupShare: sumMoney(
      provided.map((i) => i.groupShare),
      presentation,
    ),
    totalNciShare: sumMoney(
      provided.map((i) => i.nciShare),
      presentation,
    ),
  });
}

export function renderUnrealisedProfit(result: UnrealisedProfitProvision): string {
  const lines: string[] = [];
  const count = result.items.length;
  lines.push(
    `Unrealised profit on intragroup stock — ${count} ` +
      `${count === 1 ? "consignment" : "consignments"}, ` +
      `${result.totalProvision.toDecimalString()} ${result.presentation.code} provided`,
  );
  lines.push("-".repeat(96));
  for (const item of result.items) {
    lines.push(
      `${item.seller} into ${item.holder} ${item.account} ${item.accountName}`.padEnd(52) +
        item.onHandPresentation.toDecimalString().padStart(14) +
        ` on hand`,
    );
    lines.push(
      `  ${item.basis}, ${item.profitFraction.toPercentString(4)} of the price`.padEnd(52) +
        item.provision.toDecimalString().padStart(14) +
        ` provided`,
    );
    if (item.nciShare.isZero) {
      lines.push(`  all of it the group's, ${item.seller} having made the sale`);
    } else {
      lines.push(
        `  ${item.groupShare.toDecimalString()} the group's, ` +
          `${item.nciShare.toDecimalString()} the ${item.nonControlling.toPercentString(4)} ` +
          `outside ${item.seller}`,
      );
    }
  }
  for (const item of result.unprovided) {
    lines.push(
      `NOT PROVIDED ${item.declaration.seller} into ${item.declaration.holder} ` +
        `${item.declaration.account} — ${item.reason}`,
    );
  }
  if (!result.totalNciShare.isZero) {
    lines.push("-".repeat(96));
    lines.push(
      `${result.totalGroupShare.toDecimalString()} borne by the group's own shareholders, ` +
        `${result.totalNciShare.toDecimalString()} by the stakes outside the selling companies.`,
    );
  }
  return lines.join("\n");
}
