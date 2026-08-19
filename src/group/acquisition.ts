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

export interface Acquisition {
  readonly entity: string;
  readonly acquired: CalendarDate;
  readonly groupInterest: Interest;
  readonly nonControllingInterest: Interest;
  readonly measurement: NciMeasurement;
  /** All figures below are in the group's presentation currency. */
  readonly consideration: Money;
  readonly netAssetsAcquired: Money;
  /** True when the net assets came from a figure supplied rather than the books. */
  readonly netAssetsSupplied: boolean;
  readonly nciAtAcquisition: Money;
  /**
   * Goodwill. Never negative: a price below the net assets acquired shows up
   * in `bargainGain` instead.
   */
  readonly goodwill: Money;
  /** The excess of net assets acquired over what was paid for them. */
  readonly bargainGain: Money;
  /**
   * The part of `nciAtAcquisition` that is not a share of net assets — the
   * goodwill attributed to the outside shareholders. Nil under the
   * proportionate method, by construction.
   */
  readonly nciGoodwill: Money;
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

function intoPresentation(
  amount: Money,
  options: AcquisitionOptions,
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
 * Work out goodwill and the non-controlling interest at acquisition.
 *
 * Everything is measured on the day control was obtained and translated at
 * that day's rate, because that is when the bargain was struck; a rate that
 * moved afterwards changes what the group's investment is worth, not what it
 * paid.
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
  const zero = Money.zero(options.presentation);
  const consideration = intoPresentation(
    input.consideration,
    options,
    acquired,
    `The consideration for ${entity.code}`,
  );

  let netAssetsAcquired: Money;
  let netAssetsSupplied: boolean;
  if (input.netAssetsAtAcquisition !== undefined) {
    netAssetsAcquired = intoPresentation(
      input.netAssetsAtAcquisition,
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
    netAssetsAcquired = intoPresentation(
      netAssets(ledger, acquired, entity.currency),
      options,
      acquired,
      `The net assets of ${entity.code}`,
    );
    netAssetsSupplied = false;
  }

  const nci = entity.nonControlling;
  let nciAtAcquisition: Money;
  if (measurement === "fair-value") {
    if (input.nciFairValue === undefined) {
      throw new GroupError(
        `${entity.code} measures its non-controlling interest at fair value, which is a ` +
          `figure only the group has: supply nciFairValue or use the proportionate method.`,
      );
    }
    nciAtAcquisition = intoPresentation(
      input.nciFairValue,
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
    nciAtAcquisition = nci.share(netAssetsAcquired, options.rounding ?? "half-even");
  }

  const excess = consideration.plus(nciAtAcquisition).minus(netAssetsAcquired);
  const goodwill = excess.isNegative ? zero : excess;
  const bargainGain = excess.isNegative ? excess.negated() : zero;
  const nciGoodwill = nciAtAcquisition.minus(
    nci.share(netAssetsAcquired, options.rounding ?? "half-even"),
  );

  return Object.freeze({
    entity: entity.code,
    acquired,
    groupInterest: entity.effective,
    nonControllingInterest: nci,
    measurement,
    consideration,
    netAssetsAcquired,
    netAssetsSupplied,
    nciAtAcquisition,
    goodwill,
    bargainGain,
    nciGoodwill,
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

export function renderAcquisition(acquisition: Acquisition): string {
  const lines: string[] = [];
  const label = (text: string, amount: Money): string =>
    `  ${text.padEnd(44)}${amount.toDecimalString().padStart(14)}`;
  lines.push(
    `${acquisition.entity} — acquired ${acquisition.acquired}, ` +
      `${acquisition.groupInterest.toPercentString(4)} to the group, ` +
      `non-controlling interest at ${acquisition.measurement}`,
  );
  lines.push(label("Consideration transferred", acquisition.consideration));
  lines.push(label("Non-controlling interest at acquisition", acquisition.nciAtAcquisition));
  lines.push(
    label(
      `Net assets acquired${acquisition.netAssetsSupplied ? " (supplied)" : ""}`,
      acquisition.netAssetsAcquired.negated(),
    ),
  );
  if (acquisition.bargainGain.isZero) {
    lines.push(label("Goodwill", acquisition.goodwill));
    if (!acquisition.nciGoodwill.isZero) {
      lines.push(
        label("  of which attributable to the outside stake", acquisition.nciGoodwill),
      );
    }
  } else {
    lines.push(label("Gain on a bargain purchase", acquisition.bargainGain.negated()));
    lines.push("  A price below the net assets acquired is a gain, not a negative asset.");
  }
  return lines.join("\n");
}
