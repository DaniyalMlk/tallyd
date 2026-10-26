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
import {
  type CalendarDate,
  type DateRange,
  compareDates,
  date as parseDate,
} from "../ledger/date.js";
import type { Ledger } from "../ledger/ledger.js";
import { trialBalance } from "../ledger/trialBalance.js";
import type { ExchangeRate } from "../fx/rate.js";
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

/**
 * What goodwill on a foreign operation is carried at on a later date.
 *
 * Goodwill is an asset of the acquired company, so it is retranslated at every
 * reporting date like any other asset of that company: at the closing rate,
 * with the difference going to the translation reserve rather than through the
 * income statement. Holding it at the acquisition-date rate instead would be
 * carrying one asset of the subsidiary at a rate from years ago while every
 * other asset of the same subsidiary moved.
 *
 * The difference does not all belong to the group. The outside stake owns
 * whatever goodwill was attributed to it when the company was bought, so it
 * owns the exchange difference on that part too — and *only* on that part. The
 * split is therefore decided by how the stake was measured and not by how
 * large it is: under the proportionate method the stake has no goodwill at
 * all, so none of the exchange difference is its, however much of the company
 * it owns.
 *
 * The bargain purchase gain is not here. A gain is recognised once, in the
 * income statement of the period control was obtained, at the rate then; it is
 * part of reserves afterwards and not an asset sitting there to be remeasured.
 *
 * ## Impairment, and why it splits on a different basis
 *
 * An impairment reduces the measurement. It is a judgement about the business
 * the group bought, so it is a figure in that business's currency and it is
 * applied before any rate is: what is retranslated afterwards is what is left.
 *
 * Its share of it is the outside stake's *ownership* fraction, where its share
 * of the exchange difference was its share of the goodwill. The two look alike
 * and are not, because they are different kinds of thing. An exchange
 * difference is a remeasurement of an asset, so it follows whoever owns the
 * asset — and under the proportionate method the stake owns none of the
 * goodwill, so none of the difference is its, whatever fraction of the company
 * it holds. An impairment is a loss of the period, and a loss of the period is
 * shared the way every other result is: in the ratio of the interests. Using
 * one basis for both is plausible, and wrong in whichever direction it is done.
 *
 * Where the stake was measured proportionately there is nothing to share. The
 * balance sheet carries only the group's own goodwill, so the only impairment
 * that can be recognised against it is the group's; the stake's notional share
 * of a loss on goodwill it never had is not a figure the accounts contain.
 */
export interface GoodwillCarrying {
  readonly entity: string;
  readonly on: CalendarDate;
  /**
   * The measurement net of impairment, in the entity's currency. Equal to the
   * acquisition measurement where nothing has been written down.
   */
  readonly functional: Money;
  /** The measurement before impairment, which never changes. */
  readonly grossFunctional: Money;
  /** What has been written off it, in the entity's currency. */
  readonly impairedFunctional: Money;
  /** That amount at the closing rate on `on`. */
  readonly carrying: Money;
  /**
   * What the asset was first recognised at, less what has been impaired at the
   * rate the impairment was recognised at. The figure the exchange difference
   * is measured against: anything beyond this is the rate moving.
   */
  readonly atAcquisition: Money;
  /** `carrying` less `atAcquisition`: the exchange difference accumulated since. */
  readonly exchangeDifference: Money;
/**
   * The write-offs falling inside the reporting period, as the income
   * statement carries them: each at the rate on the day it was recognised.
   * Earlier write-offs are not here — they reduced the asset in a period that
   * has already been reported.
   */
  readonly impairmentLoss: Money;
  /** The outside stake's share of that charge, by its ownership fraction. */
  readonly nciImpairmentLoss: Money;
  /** The rest of it, which is the group's. */
  readonly groupImpairmentLoss: Money;
  /** This period's charge in the entity's own currency. */
  readonly chargedFunctional: Money;
  /**
   * Everything written off over the asset's life, each at the rate on its own
   * day. The figure the exchange difference is measured against.
   */
  readonly recognisedToDate: Money;
  /** The outside stake's goodwill in the entity's currency, net of its share. */
  readonly nciFunctional: Money;
  /** That amount at the closing rate. */
  readonly nciCarrying: Money;
  readonly nciAtAcquisition: Money;
  /** The exchange difference on the outside stake's goodwill, which is its own. */
  readonly nciExchangeDifference: Money;
  /** The rest of it, which is the group's and belongs in the translation reserve. */
  readonly groupExchangeDifference: Money;
  /** The rate used. Null where no translation was needed. */
  readonly rate: ExchangeRate | null;
}

/**
 * One write-off of goodwill, on the day the group decided it.
 *
 * Nothing in anybody's books says goodwill is worth less than it was: an
 * impairment is a judgement the group makes about the business it bought, so
 * it is declared rather than inferred.
 *
 * It is declared as an event with a date rather than as a running total, and
 * the date is required. Two reasons, and the second is the one that forced it.
 * A loss is translated at the rate on the day it was recognised, so a total
 * with no date has no rate. And a consolidation has to be a function of its
 * inputs: given a list of events, any reporting date can work out both what
 * has been written off by then and what was written off *during the period*,
 * which are different figures and belong in different places. A cumulative
 * total cannot tell those apart, so a comparative column would charge the
 * whole history to the later year and the figure would look plausible.
 */
export interface GoodwillImpairment {
  entity: string;
  /** What was written off on that day, in any currency. */
  amount: Money;
  /** The day the group recognised it. */
  on: string;
}

export interface GoodwillCarryingOptions {
  rates: RateTable;
  rounding?: RoundingMode;
  /**
   * Every write-off the group has declared, in any order. Events dated after
   * the date being carried at are ignored, which is what makes one list serve
   * a comparative column as well as the current one.
   */
  impairments?: readonly GoodwillImpairment[];
  /**
   * The reporting period. Events inside it are this period's charge and reach
   * the income statement; earlier ones are accumulated and only reduce the
   * asset. Without it every event on or before the carrying date counts as
   * this period's, which is right for a first period and wrong afterwards.
   */
  period?: DateRange;
}

export function goodwillAt(
  acquisition: Acquisition,
  options: GoodwillCarryingOptions,
  on: CalendarDate,
): GoodwillCarrying {
  const rounding = options.rounding ?? "half-even";
  const grossFunctional = acquisition.goodwillIn.functional;
  const grossNciFunctional = acquisition.nciGoodwillIn.functional;
  const sameCurrency = acquisition.functional.code === acquisition.presentation.code;
  const zeroFunctional = Money.zero(acquisition.functional);

  const closingRate = (when: CalendarDate, what: string): ExchangeRate => {
    try {
      return options.rates.lookup(acquisition.functional, acquisition.presentation, when).rate;
    } catch (error) {
      throw new GroupError(
        `${what} on ${acquisition.entity} is ${acquisition.functional.code} and has to be ` +
          `stated in ${acquisition.presentation.code}, but there is no rate ` +
          `on ${when}: ${(error as Error).message}`,
      );
    }
  };

  // The impairment comes off the measurement before any rate touches it: what
  // is retranslated is what is left. Events after the carrying date are not
  // yet news, and events inside the reporting period are this period's charge
  // as well as part of the accumulated total.
  const events = [...(options.impairments ?? [])]
    .map((declared) => {
      if (declared.entity !== acquisition.entity) {
        throw new GroupError(
          `An impairment of goodwill on ${declared.entity} was given to ${acquisition.entity}`,
        );
      }
      const when = parseDate(declared.on);
      if (compareDates(when, acquisition.acquired) < 0) {
        throw new GroupError(
          `Goodwill on ${acquisition.entity} is written off on ${when}, before it arose on ` +
            `${acquisition.acquired}. There was nothing there to write off.`,
        );
      }
      const amount = convertOn(
        declared.amount,
        acquisition.functional,
        {
          rates: options.rates,
          presentation: acquisition.presentation,
          ...(options.rounding === undefined ? {} : { rounding: options.rounding }),
        },
        when,
        `The impairment of goodwill on ${acquisition.entity}`,
      );
      if (amount.isNegative) {
        throw new GroupError(
          `Goodwill on ${acquisition.entity} is written back up by ${amount.negated()} on ` +
            `${when}. An impairment once recognised stays recognised.`,
        );
      }
      return { when, amount };
    })
    .filter((event) => compareDates(event.when, on) <= 0)
    .sort((a, b) => compareDates(a.when, b.when));

  const inPeriod = (when: CalendarDate): boolean =>
    options.period === undefined ||
    (compareDates(when, options.period.from) >= 0 && compareDates(when, options.period.to) <= 0);

  let impairedFunctional = zeroFunctional;
  let chargedFunctional = zeroFunctional;
  let nciImpairedFunctional = zeroFunctional;
  let nciChargedFunctional = zeroFunctional;
  // Each event's loss takes the rate on its own day, so the sum of them is
  // what the income statement has carried over the asset's life and the
  // residual against the closing rate is the rate's doing and nothing else.
  let recognisedAtTheTime = Money.zero(acquisition.presentation);
  let nciRecognisedAtTheTime = Money.zero(acquisition.presentation);
  let chargeLoss = Money.zero(acquisition.presentation);
  let nciChargeLoss = Money.zero(acquisition.presentation);

  for (const event of events) {
    // The stake bears its ownership fraction of the loss, not its share of the
    // goodwill: a loss of the period is shared the way every result is. Where
    // the stake was measured proportionately it has no goodwill on the balance
    // sheet and so no recognised share of a write-down of it.
    const nciAmount =
      acquisition.measurement === "fair-value"
        ? acquisition.nonControllingInterest.share(event.amount, rounding)
        : zeroFunctional;
    impairedFunctional = impairedFunctional.plus(event.amount);
    nciImpairedFunctional = nciImpairedFunctional.plus(nciAmount);
    if (impairedFunctional.greaterThan(grossFunctional)) {
      throw new GroupError(
        `${impairedFunctional} of goodwill is written off ${acquisition.entity} by ${event.when}, ` +
          `which only has ${grossFunctional}. Goodwill carried at a negative amount is not a ` +
          `smaller error than the one being corrected.`,
      );
    }
    if (nciImpairedFunctional.greaterThan(grossNciFunctional)) {
      throw new GroupError(
        `The outside stake's share of the impairments on ${acquisition.entity} reaches ` +
          `${nciImpairedFunctional} by ${event.when}, more than the ${grossNciFunctional} of ` +
          `goodwill attributed to it. Writing its claim below what it was given would charge ` +
          `it for goodwill it never had.`,
      );
    }
    const eventRate = sameCurrency ? null : closingRate(event.when, "The impairment of goodwill");
    const atTheTime = eventRate === null ? event.amount : eventRate.convert(event.amount, rounding);
    const nciAtTheTime = eventRate === null ? nciAmount : eventRate.convert(nciAmount, rounding);
    recognisedAtTheTime = recognisedAtTheTime.plus(atTheTime);
    nciRecognisedAtTheTime = nciRecognisedAtTheTime.plus(nciAtTheTime);
    if (inPeriod(event.when)) {
      chargedFunctional = chargedFunctional.plus(event.amount);
      nciChargedFunctional = nciChargedFunctional.plus(nciAmount);
      chargeLoss = chargeLoss.plus(atTheTime);
      nciChargeLoss = nciChargeLoss.plus(nciAtTheTime);
    }
  }
  void nciChargedFunctional;

  const functional = grossFunctional.minus(impairedFunctional);
  const nciFunctional = grossNciFunctional.minus(nciImpairedFunctional);

  let rate: ExchangeRate | null = null;
  let carrying = functional;
  let nciCarrying = nciFunctional;
  if (!sameCurrency) {
    rate = closingRate(on, "Goodwill");
    carrying = rate.convert(functional, rounding);
    nciCarrying = rate.convert(nciFunctional, rounding);
  }

  // What the asset was recognised at, less everything taken out of it through
  // the income statement over its life, each write-off at the rate on its own
  // day. Whatever is left between that and the closing-rate carrying amount is
  // the rate's doing and nothing else, which is what sends it to the reserve.
  //
  // It falls out of this that a write-off recognised at the closing rate leaves
  // the exchange difference exactly as it would have been with no write-off at
  // all: the asset is smaller and so is the figure it is measured against, by
  // the same amount. That is the test that says the two effects are apart.
  const atAcquisition = acquisition.goodwill.minus(recognisedAtTheTime);
  const nciAtAcquisition = acquisition.nciGoodwill.minus(nciRecognisedAtTheTime);
  const exchangeDifference = carrying.minus(atAcquisition);
  const nciExchangeDifference = nciCarrying.minus(nciAtAcquisition);

  return Object.freeze({
    entity: acquisition.entity,
    on,
    functional,
    grossFunctional,
    impairedFunctional,
    carrying,
    atAcquisition,
    exchangeDifference,
    impairmentLoss: chargeLoss,
    nciImpairmentLoss: nciChargeLoss,
    groupImpairmentLoss: chargeLoss.minus(nciChargeLoss),
    recognisedToDate: recognisedAtTheTime,
    chargedFunctional,
    nciFunctional,
    nciCarrying,
    nciAtAcquisition,
    nciExchangeDifference,
    groupExchangeDifference: exchangeDifference.minus(nciExchangeDifference),
    rate,
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
