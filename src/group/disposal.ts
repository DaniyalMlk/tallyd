/**
 * What was sold, what it was carried at, and the difference.
 *
 * A company that leaves the group part-way through the period is the mirror of
 * one that joins, and it is the harder half. Joining is handled by closing the
 * books at the date control was obtained: the balance sheet is the group's
 * either way, and closing only decides which side of the line the results fall
 * on. Leaving cannot be handled that way, because the balance sheet is *not*
 * the group's at the reporting date. Eight months of results have to go in and
 * no assets at all, which no amount of closing will produce.
 *
 * So a disposal is a removal, and the figure it turns on is what the group was
 * carrying the company at on the day it went:
 *
 *     carrying amount = net assets at disposal
 *                     - the outside stake's claim on them
 *                     + the goodwill recognised when it was bought
 *
 *     gain = proceeds - carrying amount
 *
 * Each term earns its place. The **net assets** are the company's own, read
 * from its own books on the day control was lost — not at the reporting date,
 * where they are somebody else's, and not at any average, because what was
 * handed over was handed over on one day. The **outside stake's claim** comes
 * off because the group never owned that part and is not selling it: the
 * shareholders outside had a claim on those net assets before the sale and
 * their claim goes with the company, which is a removal and not a
 * remeasurement — nothing about the sale changes what their share was worth to
 * them. And the **goodwill** goes because it only ever existed as a
 * consequence of holding this company; there is nothing for it to attach to
 * once the company is gone, and leaving it on the balance sheet would be
 * asserting the group still owns something it cannot name.
 *
 * The gain measured this way is not the gain the holding company records in its
 * own books, and the difference is the whole point. The holder compares the
 * proceeds with what it paid for the shares. The group compares them with the
 * net assets that have walked out of the door, which have been moving ever
 * since — every pound the subsidiary earned and did not distribute raised them,
 * and the group's share of every one of those pounds has already been reported
 * as profit in an earlier period. Recognising the holder's gain as well would
 * be reporting the same earnings twice.
 *
 * Two things this deliberately does not do.
 *
 * It does not recycle the translation reserve. Selling a foreign operation
 * ought to take the cumulative exchange differences on it out of reserves and
 * into the gain, and *cumulative* is the operative word: the consolidation
 * measures this period's translation adjustment and has never carried the
 * running total, which is a fact about several previous years of rates that no
 * single reporting date can supply.
 *
 * And it does not handle a partial disposal — selling down from 80% to 30%,
 * where control is lost but a holding remains, or from 80% to 60%, where it is
 * not lost at all and the whole thing is a transaction between owners rather
 * than a disposal. Both are real and both need a retained interest measured at
 * fair value, which is a figure only the group has.
 */

import { Money } from "../money/money.js";
import type { Currency } from "../money/currency.js";
import type { RoundingMode } from "../money/rounding.js";
import { type CalendarDate, date as parseDate } from "../ledger/date.js";
import type { Ledger } from "../ledger/ledger.js";
import type { RateTable } from "../fx/table.js";
import { Interest } from "./interest.js";
import { GroupError, type GroupStructure } from "./structure.js";
import { GROUP_ACCOUNTS } from "./accounts.js";
import { type Acquisition, netAssets } from "./acquisition.js";

export interface DisposalInput {
  /** The company sold. */
  entity: string;
  /** The day control was lost. Defaults to the entity definition's. */
  disposed?: string;
  /** What was received, in whatever currency it was received in. */
  proceeds: Money;
  /**
   * The net assets of the company on the day it went, when they are not what
   * its own books say. Supplied the same way and for the same reasons as the
   * net assets at acquisition.
   */
  netAssetsAtDisposal?: Money;
  /**
   * Where the holding company put its own gain or loss on the sale. That
   * figure is measured against the cost of the shares and is not the group's,
   * so the consolidation reverses it; it needs to know which account to
   * reverse it out of. The group's own disposal accounts by default, which is
   * where a holder using this chart would have put it.
   */
  gainAccount?: string;
  lossAccount?: string;
}

export interface Disposal {
  readonly entity: string;
  readonly disposed: CalendarDate;
  readonly groupInterest: Interest;
  readonly nonControllingInterest: Interest;
  /** All figures below are in the group's presentation currency. */
  readonly proceeds: Money;
  readonly netAssetsAtDisposal: Money;
  /** True when the net assets came from a figure supplied rather than the books. */
  readonly netAssetsSupplied: boolean;
  /** The outside stake's claim on the day it went, goodwill attributed to it included. */
  readonly nciAtDisposal: Money;
  /** The goodwill that has to come off with the company. */
  readonly goodwillDerecognised: Money;
  /** Net assets, less the outside stake, plus goodwill. What the group is giving up. */
  readonly carryingAmount: Money;
  /** Proceeds over the carrying amount. Nil when the sale was at a loss. */
  readonly gain: Money;
  /** The carrying amount over the proceeds. Nil when the sale was at a gain. */
  readonly loss: Money;
  /**
   * What the holder itself made on the sale: the proceeds less what it paid for
   * the shares. Reversed out of the consolidated result and replaced by the
   * group's own figure.
   */
  readonly holderResult: Money;
  /** The account the holder's own gain or loss has to be reversed out of. */
  readonly holderAccount: string;
  /** Which of the group's two accounts the result belongs in. */
  readonly account: string;
  /** The investment account the holder no longer carries the company in. */
  readonly investmentAccount: string;
}

export interface DisposalOptions {
  rates: RateTable;
  presentation: Currency;
  rounding?: RoundingMode;
}

function intoPresentation(
  amount: Money,
  options: DisposalOptions,
  on: CalendarDate,
  what: string,
): Money {
  if (amount.currency.code === options.presentation.code) return amount;
  try {
    return options.rates
      .lookup(amount.currency, options.presentation, on)
      .rate.convert(amount, options.rounding ?? "half-even");
  } catch (error) {
    throw new GroupError(
      `${what} is in ${amount.currency.code} and the group reports in ` +
        `${options.presentation.code}, but there is no rate on ${on}: ${(error as Error).message}`,
    );
  }
}

/**
 * Work out the gain or loss on a company that has left the group.
 *
 * Everything is measured on the day control was lost and translated at that
 * day's rate, for the same reason an acquisition is measured on the day of the
 * bargain: what the group handed over, it handed over then, and a rate that
 * moved afterwards is somebody else's problem.
 *
 * The acquisition is an argument rather than something looked up because the
 * goodwill that comes off has to be the goodwill that went on. Recomputing it
 * here from the same inputs would give the same answer and would be a second
 * place for it to be computed differently.
 */
export function disposalOf(
  group: GroupStructure,
  ledgers: ReadonlyMap<string, Ledger> | Readonly<Record<string, Ledger>>,
  input: DisposalInput,
  acquisition: Acquisition,
  options: DisposalOptions,
): Disposal {
  const entity = group.get(input.entity);
  if (entity.code === group.parent) {
    throw new GroupError(
      `${entity.code} is the parent company. A group that sold its own parent is not a ` +
        `group with a disposal in it, it is a different group.`,
    );
  }
  if (!entity.controlled) {
    throw new GroupError(
      `${entity.code} is not consolidated, so there is nothing to remove from the group's ` +
        `books. Selling it is a movement on the investment and not a disposal of a subsidiary.`,
    );
  }
  if (acquisition.entity !== entity.code) {
    throw new GroupError(
      `The disposal of ${entity.code} was given the acquisition of ${acquisition.entity}`,
    );
  }

  const disposedText = input.disposed ?? entity.disposed;
  if (disposedText === null || disposedText === undefined) {
    throw new GroupError(
      `${entity.code} needs the date control was lost: without it there is no day to ` +
        `measure the net assets that were handed over.`,
    );
  }
  const disposed = parseDate(String(disposedText));

  const rounding = options.rounding ?? "half-even";
  const zero = Money.zero(options.presentation);
  const proceeds = intoPresentation(
    input.proceeds,
    options,
    disposed,
    `The proceeds of ${entity.code}`,
  );

  let netAssetsAtDisposal: Money;
  let netAssetsSupplied: boolean;
  if (input.netAssetsAtDisposal !== undefined) {
    netAssetsAtDisposal = intoPresentation(
      input.netAssetsAtDisposal,
      options,
      disposed,
      `The net assets of ${entity.code} on disposal`,
    );
    netAssetsSupplied = true;
  } else {
    const ledger =
      ledgers instanceof Map
        ? ledgers.get(entity.code)
        : (ledgers as Readonly<Record<string, Ledger>>)[entity.code];
    if (ledger === undefined) {
      throw new GroupError(
        `No books for ${entity.code}, so what left the group with it cannot be measured`,
      );
    }
    netAssetsAtDisposal = intoPresentation(
      netAssets(ledger, disposed, entity.currency),
      options,
      disposed,
      `The net assets of ${entity.code}`,
    );
    netAssetsSupplied = false;
  }

  // The outside stake's claim is its share of the net assets now, plus whatever
  // goodwill was attributed to it when the company was bought — the same
  // formulation the consolidation uses at any other date, so that the claim
  // being removed is exactly the claim that was there the day before.
  const nci = entity.nonControlling;
  const nciAtDisposal = nci.share(netAssetsAtDisposal, rounding).plus(acquisition.nciGoodwill);
  const goodwillDerecognised = acquisition.goodwill;
  const carryingAmount = netAssetsAtDisposal.minus(nciAtDisposal).plus(goodwillDerecognised);

  const difference = proceeds.minus(carryingAmount);
  const gain = difference.isNegative ? zero : difference;
  const loss = difference.isNegative ? difference.negated() : zero;
  const holderResult = proceeds.minus(acquisition.consideration);

  return Object.freeze({
    entity: entity.code,
    disposed,
    groupInterest: entity.effective,
    nonControllingInterest: nci,
    proceeds,
    netAssetsAtDisposal,
    netAssetsSupplied,
    nciAtDisposal,
    goodwillDerecognised,
    carryingAmount,
    gain,
    loss,
    holderResult,
    holderAccount: holderResult.isNegative
      ? (input.lossAccount ?? GROUP_ACCOUNTS.disposalLoss)
      : (input.gainAccount ?? GROUP_ACCOUNTS.disposalGain),
    account: difference.isNegative ? GROUP_ACCOUNTS.disposalLoss : GROUP_ACCOUNTS.disposalGain,
    investmentAccount: acquisition.investmentAccount,
  });
}

/**
 * Every disposal in a group, in the structure's order.
 *
 * A disposal declared for an entity whose books say nothing about a sale is an
 * error rather than an instruction, because the two have to agree: the
 * structure decides which period the company's results belong to and this
 * decides what the sale was worth, and a consolidation where one of them thinks
 * the company is still owned would be wrong in a way that still balances.
 */
export function disposals(
  group: GroupStructure,
  ledgers: ReadonlyMap<string, Ledger> | Readonly<Record<string, Ledger>>,
  inputs: readonly DisposalInput[],
  acquired: readonly Acquisition[],
  options: DisposalOptions,
): readonly Disposal[] {
  const seen = new Set<string>();
  for (const input of inputs) {
    if (seen.has(input.entity)) {
      throw new GroupError(`${input.entity} is disposed of twice in the same group`);
    }
    seen.add(input.entity);
  }
  const byEntity = new Map(acquired.map((a) => [a.entity, a]));
  const order = new Map(group.order.map((code, index) => [code, index]));
  return Object.freeze(
    [...inputs]
      .sort((a, b) => (order.get(a.entity) ?? 0) - (order.get(b.entity) ?? 0))
      .map((input) => {
        const acquisition = byEntity.get(input.entity);
        if (acquisition === undefined) {
          throw new GroupError(
            `${input.entity} is disposed of but never acquired. Without what was paid there ` +
              `is no goodwill to take off with it and no carrying amount to measure against.`,
          );
        }
        return disposalOf(group, ledgers, input, acquisition, options);
      }),
  );
}

export function renderDisposal(disposal: Disposal): string {
  const lines: string[] = [];
  const label = (text: string, amount: Money): string =>
    `  ${text.padEnd(44)}${amount.toDecimalString().padStart(14)}`;
  lines.push(
    `${disposal.entity} — disposed of ${disposal.disposed}, ` +
      `${disposal.groupInterest.toPercentString(4)} of it the group's`,
  );
  lines.push(label("Proceeds", disposal.proceeds));
  lines.push(
    label(
      `Net assets going with it${disposal.netAssetsSupplied ? " (supplied)" : ""}`,
      disposal.netAssetsAtDisposal.negated(),
    ),
  );
  if (!disposal.nciAtDisposal.isZero) {
    lines.push(label("  less the outside stake's claim on them", disposal.nciAtDisposal));
  }
  if (!disposal.goodwillDerecognised.isZero) {
    lines.push(label("Goodwill derecognised", disposal.goodwillDerecognised.negated()));
  }
  lines.push(label("Carrying amount", disposal.carryingAmount.negated()));
  lines.push(
    disposal.loss.isZero
      ? label("Gain on disposal", disposal.gain)
      : label("Loss on disposal", disposal.loss.negated()),
  );
  if (!disposal.holderResult.equals(disposal.gain.minus(disposal.loss))) {
    lines.push(
      `  The holder's own books make it ${disposal.holderResult.toDecimalString()}, measured ` +
        `against what it paid for the shares. That figure is reversed.`,
    );
  }
  return lines.join("\n");
}
