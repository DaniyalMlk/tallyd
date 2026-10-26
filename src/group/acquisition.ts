/**
 * What was paid, what was bought, and what belongs to everybody else.
 *
 * A combined trial balance still carries the parent's investment in each
 * subsidiary as an asset *and* the subsidiary's own share capital as equity,
 * which is the same money on the page twice: the investment is a claim on
 * exactly the net assets that are already there line by line. Both come out,
 * and what is left over is goodwill — the part of the price that bought
 * something the subsidiary's balance sheet does not carry.
 *
 *     goodwill = consideration + non-controlling interest at acquisition
 *                - the net assets acquired
 *
 * The non-controlling interest belongs in that sum because goodwill is a
 * measure of what the whole company was worth against what its identifiable
 * net assets were worth, and the group only bought part of it. How the
 * non-controlling interest is measured is a choice the group makes per
 * acquisition and it changes the goodwill figure:
 *
 * - **Proportionate**: its share of the identifiable net assets. Goodwill is
 *   then only the group's own, and the balance sheet carries none of the
 *   goodwill attributable to the outside shareholders.
 * - **Fair value**: what the outside stake was actually worth on the day,
 *   which is usually more, and the difference is the goodwill attributable to
 *   the non-controlling interest.
 *
 * A price below the net assets acquired is a bargain purchase, and the excess
 * is a gain in the income statement rather than a negative asset. Negative
 * goodwill sitting in the balance sheet would be asserting that the group owns
 * something worth less than nothing.
 *
 * Afterwards, the two sides share what the subsidiary earns in the ratio of
 * their interests. The non-controlling interest's claim at any date is its
 * share of the net assets then, plus whatever goodwill was attributed to it at
 * acquisition — a formulation that needs no roll-forward and cannot drift.
 *
 * On an indirect holding this uses the direct method: a company held 75% by a
 * subsidiary that is itself held 80% has a 40% non-controlling interest from
 * the group's point of view, and its goodwill is measured against the price
 * the subsidiary paid. The alternative treatment, which scales the cost of the
 * investment by the group's interest in the buyer, is a known gap.
 *
 * ## Which currency the arithmetic happens in
 *
 * All of it happens in the currency the acquired company keeps its books in,
 * and the answer is then translated into the group's. That ordering is not a
 * matter of taste. Goodwill on a foreign operation is an asset *of that
 * operation*: what the extra money bought — a name, a position, people who
 * stay — is a thing in that country, priced in that currency, and the group
 * owning it does not move it. So the consideration comes the other way for the
 * purposes of this sum, into the subsidiary's currency at the rate on the day,
 * and the net assets read from its own books need no translating because they
 * are already there.
 *
 * Doing it the other way round — translating each input into the group's
 * currency and taking the residual there — gives a figure that cannot be
 * retranslated afterwards, because there is no functional-currency amount left
 * to retranslate, and one that carries three roundings instead of one: each
 * input is rounded on its way across and goodwill is defined as the difference
 * between them, so the error lands in the one figure with nothing to absorb it.
 *
 * A group reporting in the currency its subsidiary already keeps is untouched
 * by any of this: no rate is looked up and nothing moves.
 */

import { Money } from "../money/money.js";
import type { Currency } from "../money/currency.js";
import type { RoundingMode } from "../money/rounding.js";
import { type CalendarDate, date as parseDate } from "../ledger/date.js";
import type { Ledger } from "../ledger/ledger.js";
import { trialBalance } from "../ledger/trialBalance.js";
import type { RateTable } from "../fx/table.js";
import { Interest } from "./interest.js";
import { GroupError, type GroupStructure } from "./structure.js";
import { GROUP_ACCOUNTS } from "./accounts.js";

export type NciMeasurement = "proportionate" | "fair-value";

export interface AcquisitionInput {
  /** The company acquired. */
  entity: string;
  /** The day control was obtained. Defaults to the entity definition's. */
  acquired?: string;
  /** What was paid, in whatever currency it was paid in. */
  consideration: Money;
  /**
   * How the non-controlling interest is measured. Fair value needs a figure;
   * proportionate computes one from the net assets.
   */
  nciMeasurement?: NciMeasurement;
  /** The outside stake's fair value on the day. Required for `fair-value`. */
  nciFairValue?: Money;
  /**
   * The fair value of the identifiable net assets acquired, when it is not
   * what the subsidiary's own books said. Fair value adjustments on
   * acquisition are otherwise not modelled.
   */
  netAssetsAtAcquisition?: Money;
  /** Which account in the holder's books carries the investment. */
  investmentAccount?: string;
}

/**
 * One figure in both currencies.
 *
 * `functional` is the measurement — the amount in the currency the acquired
 * company keeps its books in, which is where the arithmetic happened.
 * `presentation` is that same amount translated once at the acquisition-date
 * rate. Where the two currencies are the same they are the same object.
 */
export interface AcquiredAmount {
  readonly functional: Money;
  readonly presentation: Money;
}

export interface Acquisition {
  readonly entity: string;
  readonly acquired: CalendarDate;
  readonly groupInterest: Interest;
  readonly nonControllingInterest: Interest;
  readonly measurement: NciMeasurement;
  /** The currency the acquired company keeps its books in. */
  readonly functional: Currency;
  /** The group's presentation currency. */
  readonly presentation: Currency;
  /**
   * All the bare `Money` figures below are in the group's presentation
   * currency, translated at the acquisition-date rate. The `*In` fields beside
   * them carry the same figure in both currencies; the functional side is the
   * measurement and the presentation side is derived from it.
   */
  readonly consideration: Money;
  readonly considerationIn: AcquiredAmount;
  readonly netAssetsAcquired: Money;
  readonly netAssetsAcquiredIn: AcquiredAmount;
  /** True when the net assets came from a figure supplied rather than the books. */
  readonly netAssetsSupplied: boolean;
  readonly nciAtAcquisition: Money;
  readonly nciAtAcquisitionIn: AcquiredAmount;
  /**
   * Goodwill. Never negative: a price below the net assets acquired shows up
   * in `bargainGain` instead.
   */
  readonly goodwill: Money;
  readonly goodwillIn: AcquiredAmount;
  /** The excess of net assets acquired over what was paid for them. */
  readonly bargainGain: Money;
  readonly bargainGainIn: AcquiredAmount;
  /**
   * The part of `nciAtAcquisition` that is not a share of net assets — the
   * goodwill attributed to the outside shareholders. Nil under the
   * proportionate method, by construction.
   */
  readonly nciGoodwill: Money;
  readonly nciGoodwillIn: AcquiredAmount;
  readonly investmentAccount: string;
}

export interface AcquisitionOptions {
  rates: RateTable;
  presentation: Currency;
  rounding?: RoundingMode;
}

/**
 * The net assets of an entity on a date, read from its own books.
 *
 * Assets less liabilities, which in the signed convention is simply the sum of
 * the asset and liability rows: the trial balance's other rows are the claims
 * on them.
 */
export function netAssets(ledger: Ledger, asAt: CalendarDate, currency: Currency): Money {
  const tb = trialBalance(ledger, { currency, asAt, includeZero: true });
  return tb.rows
    .filter((row) => row.type === "asset" || row.type === "liability")
    .reduce((running, row) => running.plus(row.signed), Money.zero(currency));
}

/**
 * One amount into another currency at a given day's rate.
 *
 * `why` finishes the sentence "there is no rate on <date>" in the error, so a
 * caller who has not supplied a quote is told which figure needed it and which
 * way it was going rather than being handed a bare lookup failure.
 */
function convertOn(
  amount: Money,
  into: Currency,
  options: AcquisitionOptions,
  on: CalendarDate,
  what: string,
): Money {
  if (amount.currency.code === into.code) return amount;
  try {
    return options.rates
      .lookup(amount.currency, into, on)
      .rate.convert(amount, options.rounding ?? "half-even");
  } catch (error) {
    throw new GroupError(
      `${what} is in ${amount.currency.code} and has to be stated in ${into.code}, ` +
        `but there is no rate on ${on}: ${(error as Error).message}`,
    );
  }
}

/**
 * A functional-currency measurement and its presentation-currency statement.
 *
 * The translation happens here and only here, so every figure on an
 * `Acquisition` is one rounding away from the amount it was measured as.
 */
function measured(
  functional: Money,
  options: AcquisitionOptions,
  on: CalendarDate,
  what: string,
): AcquiredAmount {
  return Object.freeze({
    functional,
    presentation: convertOn(functional, options.presentation, options, on, what),
  });
}

/**
 * Work out goodwill and the non-controlling interest at acquisition.
 *
 * Everything is measured on the day control was obtained, in the acquired
 * company's own currency, and translated at that day's rate. The date is the
 * acquisition date because that is when the bargain was struck: a rate that
 * moved afterwards changes what the group's investment is worth, not what it
 * paid. The currency is the subsidiary's because goodwill is an asset of the
 * subsidiary; see the note at the top of this file.
 */
export function acquisitionOf(
  group: GroupStructure,
  ledgers: ReadonlyMap<string, Ledger> | Readonly<Record<string, Ledger>>,
  input: AcquisitionInput,
  options: AcquisitionOptions,
): Acquisition {
  const entity = group.get(input.entity);
  if (entity.code === group.parent) {
    throw new GroupError(`${entity.code} is the parent company; nobody acquired it`);
  }
  if (!entity.controlled) {
    throw new GroupError(
      `${entity.code} is not consolidated, so there is no acquisition to account for. ` +
        `It is held ${entity.effective.toPercentString(4)} and carried at cost.`,
    );
  }

  const acquiredText = input.acquired ?? entity.acquired;
  if (acquiredText === null || acquiredText === undefined) {
    throw new GroupError(
      `${entity.code} needs the date control was obtained: without it there is no way ` +
        `to tell pre-acquisition reserves from post-acquisition ones.`,
    );
  }
  const acquired = parseDate(acquiredText);

  const measurement = input.nciMeasurement ?? "proportionate";
  const rounding = options.rounding ?? "half-even";
  const functional = entity.currency;
  const zero = Money.zero(functional);

  // Everything below is in the acquired company's own currency.
  const consideration = convertOn(
    input.consideration,
    functional,
    options,
    acquired,
    `The consideration for ${entity.code}`,
  );

  let netAssetsAcquired: Money;
  let netAssetsSupplied: boolean;
  if (input.netAssetsAtAcquisition !== undefined) {
    netAssetsAcquired = convertOn(
      input.netAssetsAtAcquisition,
      functional,
      options,
      acquired,
      `The net assets acquired with ${entity.code}`,
    );
    netAssetsSupplied = true;
  } else {
    const ledger =
      ledgers instanceof Map
        ? ledgers.get(entity.code)
        : (ledgers as Readonly<Record<string, Ledger>>)[entity.code];
    if (ledger === undefined) {
      throw new GroupError(`No books for ${entity.code}, so its net assets cannot be read`);
    }
    netAssetsAcquired = netAssets(ledger, acquired, functional);
    netAssetsSupplied = false;
  }

  const nci = entity.nonControlling;
  const nciShareOfNetAssets = nci.share(netAssetsAcquired, rounding);
  let nciAtAcquisition: Money;
  if (measurement === "fair-value") {
    if (input.nciFairValue === undefined) {
      throw new GroupError(
        `${entity.code} measures its non-controlling interest at fair value, which is a ` +
          `figure only the group has: supply nciFairValue or use the proportionate method.`,
      );
    }
    nciAtAcquisition = convertOn(
      input.nciFairValue,
      functional,
      options,
      acquired,
      `The fair value of the non-controlling interest in ${entity.code}`,
    );
  } else {
    if (input.nciFairValue !== undefined) {
      throw new GroupError(
        `${entity.code} gives a fair value for its non-controlling interest but measures it ` +
          `proportionately, so the figure would be ignored. Say which is meant.`,
      );
    }
    nciAtAcquisition = nciShareOfNetAssets;
  }

  const excess = consideration.plus(nciAtAcquisition).minus(netAssetsAcquired);
  const goodwill = excess.isNegative ? zero : excess;
  const bargainGain = excess.isNegative ? excess.negated() : zero;
  const nciGoodwill = nciAtAcquisition.minus(nciShareOfNetAssets);

  const considerationIn = measured(
    consideration,
    options,
    acquired,
    `The consideration for ${entity.code}`,
  );
  const netAssetsAcquiredIn = measured(
    netAssetsAcquired,
    options,
    acquired,
    `The net assets acquired with ${entity.code}`,
  );
  const nciAtAcquisitionIn = measured(
    nciAtAcquisition,
    options,
    acquired,
    `The non-controlling interest in ${entity.code} at acquisition`,
  );
  const goodwillIn = measured(goodwill, options, acquired, `Goodwill on ${entity.code}`);
  const bargainGainIn = measured(
    bargainGain,
    options,
    acquired,
    `The bargain purchase gain on ${entity.code}`,
  );
  const nciGoodwillIn = measured(
    nciGoodwill,
    options,
    acquired,
    `The outside stake's goodwill on ${entity.code}`,
  );

  return Object.freeze({
    entity: entity.code,
    acquired,
    groupInterest: entity.effective,
    nonControllingInterest: nci,
    measurement,
    functional,
    presentation: options.presentation,
    consideration: considerationIn.presentation,
    considerationIn,
    netAssetsAcquired: netAssetsAcquiredIn.presentation,
    netAssetsAcquiredIn,
    netAssetsSupplied,
    nciAtAcquisition: nciAtAcquisitionIn.presentation,
    nciAtAcquisitionIn,
    goodwill: goodwillIn.presentation,
    goodwillIn,
    bargainGain: bargainGainIn.presentation,
    bargainGainIn,
    nciGoodwill: nciGoodwillIn.presentation,
    nciGoodwillIn,
    investmentAccount: input.investmentAccount ?? GROUP_ACCOUNTS.investment,
  });
}

/** Every acquisition in a group, in the structure's order. */
export function acquisitions(
  group: GroupStructure,
  ledgers: ReadonlyMap<string, Ledger> | Readonly<Record<string, Ledger>>,
  inputs: readonly AcquisitionInput[],
  options: AcquisitionOptions,
): readonly Acquisition[] {
  const seen = new Set<string>();
  for (const input of inputs) {
    if (seen.has(input.entity)) {
      throw new GroupError(`${input.entity} is acquired twice in the same group`);
    }
    seen.add(input.entity);
  }
  const missing = group
    .consolidated()
    .filter((e) => e.code !== group.parent && !seen.has(e.code))
    .map((e) => e.code);
  if (missing.length > 0) {
    throw new GroupError(
      `No acquisition for ${missing.join(", ")}. Without what was paid there is no goodwill ` +
        `and no way to eliminate the investment against the equity it bought.`,
    );
  }
  const order = new Map(group.order.map((code, index) => [code, index]));
  return Object.freeze(
    [...inputs]
      .sort((a, b) => (order.get(a.entity) ?? 0) - (order.get(b.entity) ?? 0))
      .map((input) => acquisitionOf(group, ledgers, input, options)),
  );
}

/**
 * The workings behind goodwill, as a reader would check them.
 *
 * Where the acquired company keeps its books in another currency the figures
 * are shown in both: the subsidiary's currency, which is where the subtraction
 * happened, and the group's beside it. Showing only the translated column
 * would leave a reader adding up three sterling figures that do not quite make
 * the fourth, because each of them is a rounding of something else.
 */
export function renderAcquisition(acquisition: Acquisition): string {
  const lines: string[] = [];
  const foreign = acquisition.functional.code !== acquisition.presentation.code;
  const label = (text: string, amount: AcquiredAmount, negated = false): string => {
    const take = (money: Money): string =>
      (negated ? money.negated() : money).toDecimalString();
    const presentation = take(amount.presentation).padStart(14);
    if (!foreign) return `  ${text.padEnd(44)}${presentation}`;
    return `  ${text.padEnd(44)}${take(amount.functional).padStart(14)}${presentation}`;
  };
  lines.push(
    `${acquisition.entity} — acquired ${acquisition.acquired}, ` +
      `${acquisition.groupInterest.toPercentString(4)} to the group, ` +
      `non-controlling interest at ${acquisition.measurement}`,
  );
  if (foreign) {
    lines.push(
      `  ${"".padEnd(44)}${acquisition.functional.code.padStart(14)}` +
        `${acquisition.presentation.code.padStart(14)}`,
    );
  }
  lines.push(label("Consideration transferred", acquisition.considerationIn));
  lines.push(label("Non-controlling interest at acquisition", acquisition.nciAtAcquisitionIn));
  lines.push(
    label(
      `Net assets acquired${acquisition.netAssetsSupplied ? " (supplied)" : ""}`,
      acquisition.netAssetsAcquiredIn,
      true,
    ),
  );
  if (acquisition.bargainGain.isZero) {
    lines.push(label("Goodwill", acquisition.goodwillIn));
    if (!acquisition.nciGoodwill.isZero) {
      lines.push(label("  of which attributable to the outside stake", acquisition.nciGoodwillIn));
    }
    if (foreign) {
      lines.push(
        `  Measured in ${acquisition.functional.code} and translated at the rate on ` +
          `${acquisition.acquired}: goodwill on a foreign operation is an asset of that ` +
          `operation.`,
      );
    }
  } else {
    lines.push(label("Gain on a bargain purchase", acquisition.bargainGainIn, true));
    lines.push("  A price below the net assets acquired is a gain, not a negative asset.");
  }
  return lines.join("\n");
}
