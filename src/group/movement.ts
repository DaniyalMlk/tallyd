/**
 * What happened between two reporting dates.
 *
 * A consolidation is a photograph. Everything in it is measured at one date,
 * which is the right way to measure it — the non-controlling interest computed
 * from the closing balance sheet cannot drift, where one rolled forward from
 * last period's can — but it means the two figures a reader most wants
 * explained are the two the consolidation says least about. The outside
 * stake went from one number to another and the translation reserve went from
 * one number to another, and nothing anywhere says why.
 *
 * The answer has to come from a decomposition of the underlying net assets,
 * because that is what both figures are shares of. For an entity kept in a
 * currency other than the group's, three separate things move it between two
 * dates:
 *
 * 1. **The currency.** The opening net assets are the same amount of euros as
 *    they were, and a different number of pounds. Nothing happened inside the
 *    company at all.
 * 2. **The result.** What the entity earned over the period, translated at the
 *    period's average rate, which is the rate the consolidated income
 *    statement uses.
 * 3. **Everything else.** Dividends paid, capital introduced — and, unavoidably,
 *    the difference between translating this period's result at the average
 *    rate and carrying it at the closing one.
 *
 * The third of those is a residual, and calling it that honestly is better
 * than pretending it is only dividends. What matters is that the three are
 * exhaustive: opening plus all three equals closing, exactly, for every
 * entity, with no rounding anywhere, because the third is defined as what is
 * left. `netAssetsMovement` returns that identity and the tests check it
 * rather than trusting this comment.
 *
 * The first one is the one worth being careful about, because getting it wrong
 * is invisible. Retranslating the opening net assets means retranslating the
 * rows that were carried at a rate, and *not* the rows that were not. An
 * investment in a subsidiary is held at what was paid for it: it is a fact
 * about the day of the purchase and no later rate touches it. Restating it at
 * this year's closing rate would produce a currency movement on a balance that
 * never moved, and the residual would silently absorb the same figure with the
 * opposite sign, so the identity would still hold and both lines would be
 * wrong. So the retranslation reads the prior consolidation's own translated
 * rows and applies the current closing rate only where the basis was closing.
 *
 * The share schedules are then built by applying the outside stake's fraction
 * to each component. That does introduce rounding — three roundings where the
 * directly measured figure has one — so the schedule carries a `unexplained`
 * line for the difference between what it adds up to and what the
 * consolidation actually reports. It is a minor unit or two when everything is
 * working. It is a large number when something is wrong, which is the point of
 * showing it rather than plugging it into the last line.
 */

import { Money, sumMoney } from "../money/money.js";
import type { Currency } from "../money/currency.js";
import type { RoundingMode } from "../money/rounding.js";
import type { CalendarDate } from "../ledger/date.js";
import type { RateTable } from "../fx/table.js";
import { GroupError } from "./structure.js";
import type { Consolidation } from "./consolidate.js";

/**
 * One entity's net assets, taken apart between two dates.
 *
 * Every figure is in the group's presentation currency. The identity
 * `opening + translationEffect + result + other === closing` holds exactly.
 */
export interface NetAssetsMovement {
  readonly entity: string;
  readonly functional: Currency;
  readonly presentation: Currency;
  readonly openingDate: CalendarDate;
  readonly closingDate: CalendarDate;
  /** Net assets at the opening date, at the opening date's closing rate. */
  readonly opening: Money;
  /** The same functional-currency figure, restated at the current rate. */
  readonly openingRetranslated: Money;
  /** What the currency alone did to the opening balance. */
  readonly translationEffect: Money;
  /** The period's result, translated at the period's average rate. */
  readonly result: Money;
  /** Dividends, capital, and the average-versus-closing difference on the result. */
  readonly other: Money;
  /** Net assets at the reporting date, at the reporting date's closing rate. */
  readonly closing: Money;
  /** True when the entity was consolidated at the opening date too. */
  readonly comparable: boolean;
}

export interface MovementLine {
  readonly label: string;
  readonly amount: Money;
}

/**
 * Opening to closing for a figure the consolidation measures directly.
 *
 * `lines` are the components in the order they should be printed; `closing` is
 * what the consolidation reports, not the sum of the lines. `unexplained` is
 * the difference, and it is a line in its own right rather than an adjustment
 * to another one.
 */
export interface MovementSchedule {
  readonly what: string;
  readonly opening: Money;
  readonly lines: readonly MovementLine[];
  readonly closing: Money;
  readonly unexplained: Money;
  /** The closing figure the lines add up to, before `unexplained`. */
  readonly rolledForward: Money;
  readonly reconciles: boolean;
}

/** The outside stake's movement, per entity and in total. */
export interface NciMovement {
  readonly entity: string;
  readonly opening: Money;
  readonly shareOfTranslation: Money;
  readonly shareOfResult: Money;
  readonly shareOfOther: Money;
  readonly arisingOnAcquisition: Money;
  readonly closing: Money;
  readonly unexplained: Money;
}

export interface MovementOptions {
  rates: RateTable;
  rounding?: RoundingMode;
}

function intoPresentation(
  amount: Money,
  presentation: Currency,
  rates: RateTable,
  on: CalendarDate,
  what: string,
  rounding: RoundingMode,
): Money {
  if (amount.currency.code === presentation.code) return amount;
  try {
    return rates.lookup(amount.currency, presentation, on).rate.convert(amount, rounding);
  } catch (error) {
    throw new GroupError(
      `${what} is in ${amount.currency.code} and the group reports in ${presentation.code}, ` +
        `but there is no rate on ${on}: ${(error as Error).message}`,
    );
  }
}

/**
 * Take an entity's net-asset movement apart, between two consolidations.
 *
 * The opening and closing figures come from the consolidations themselves, so
 * they are exactly the numbers the balance sheets carry. The retranslated
 * opening is the only one of the four that appears in neither, and it is built
 * here from the prior consolidation's own translated rows: each asset and
 * liability that was carried at a closing rate is restated at this reporting
 * date's closing rate, and each one that was not is left exactly as it was.
 */
export function netAssetsMovement(
  entity: string,
  prior: Consolidation,
  current: Consolidation,
  options: MovementOptions,
): NetAssetsMovement {
  const presentation = current.presentation;
  const rounding = options.rounding ?? "half-even";
  const zero = Money.zero(presentation);
  if (prior.presentation.code !== presentation.code) {
    throw new GroupError(
      `The two consolidations report in different currencies — ${prior.presentation.code} ` +
        `and ${presentation.code} — so nothing can be compared between them.`,
    );
  }

  const currentWorking = current.workings.find((w) => w.entity === entity);
  const priorWorking = prior.workings.find((w) => w.entity === entity);
  const definition = current.group.get(entity);

  const closing = currentWorking?.netAssetsNow ?? zero;
  const result = currentWorking?.profitForPeriod ?? zero;
  const opening = priorWorking?.netAssetsNow ?? zero;
  const comparable = priorWorking !== undefined;

  // The opening balance as this period's balance sheet would carry it.
  let openingRetranslated = opening;
  if (comparable && definition.currency.code !== presentation.code) {
    const rows = prior.aggregation.entities.find((c) => c.entity === entity)?.translation.rows ?? [];
    openingRetranslated = rows
      .filter((row) => row.type === "asset" || row.type === "liability" || row.type === null)
      .reduce(
        (running, row) =>
          running.plus(
            row.basis === "closing"
              ? intoPresentation(
                  row.functional,
                  presentation,
                  options.rates,
                  current.asAt,
                  `${entity} ${row.account}`,
                  rounding,
                )
              : row.presentation,
          ),
        zero,
      );
  }

  const translationEffect = openingRetranslated.minus(opening);
  const other = closing.minus(openingRetranslated).minus(result);

  return Object.freeze({
    entity,
    functional: definition.currency,
    presentation,
    openingDate: prior.asAt,
    closingDate: current.asAt,
    opening,
    openingRetranslated,
    translationEffect,
    result,
    other,
    closing,
    comparable,
  });
}

/** Every consolidated entity's movement, in the group's order. */
export function netAssetsMovements(
  prior: Consolidation,
  current: Consolidation,
  options: MovementOptions,
): readonly NetAssetsMovement[] {
  return Object.freeze(
    current.workings.map((w) => netAssetsMovement(w.entity, prior, current, options)),
  );
}

/**
 * The outside stake's claim, from one reporting date to the next.
 *
 * Each component of the entity's net-asset movement gets the outside stake's
 * fraction applied to it. An entity consolidated this period and not last is
 * an acquisition: its whole opening claim arises in the period, and it is
 * shown on its own line rather than folded into a share of something.
 */
export function nciMovements(
  prior: Consolidation,
  current: Consolidation,
  options: MovementOptions,
): readonly NciMovement[] {
  const rounding = options.rounding ?? "half-even";
  const zero = Money.zero(current.presentation);
  const movements = netAssetsMovements(prior, current, options);

  return Object.freeze(
    movements.map((movement) => {
      const entity = current.group.get(movement.entity);
      const nci = entity.nonControlling;
      const currentWorking = current.workings.find((w) => w.entity === movement.entity);
      const priorWorking = prior.workings.find((w) => w.entity === movement.entity);
      const closing = currentWorking?.nciClosing ?? zero;

      if (!movement.comparable) {
        // Acquired in the period. Nothing was there to move.
        const nciGoodwill = currentWorking?.acquisition.nciGoodwill ?? zero;
        const arising = nci.share(movement.closing, rounding).plus(nciGoodwill);
        return Object.freeze({
          entity: movement.entity,
          opening: zero,
          shareOfTranslation: zero,
          shareOfResult: zero,
          shareOfOther: zero,
          arisingOnAcquisition: arising,
          closing,
          unexplained: closing.minus(arising),
        });
      }

      const opening = priorWorking?.nciClosing ?? zero;
      const shareOfTranslation = nci.share(movement.translationEffect, rounding);
      const shareOfResult = currentWorking?.nciProfitShare ?? nci.share(movement.result, rounding);
      const shareOfOther = nci.share(movement.other, rounding);
      const rolled = opening
        .plus(shareOfTranslation)
        .plus(shareOfResult)
        .plus(shareOfOther);
      return Object.freeze({
        entity: movement.entity,
        opening,
        shareOfTranslation,
        shareOfResult,
        shareOfOther,
        arisingOnAcquisition: zero,
        closing,
        unexplained: closing.minus(rolled),
      });
    }),
  );
}

/** The group's outside stake, rolled forward as one schedule. */
export function nciSchedule(
  prior: Consolidation,
  current: Consolidation,
  options: MovementOptions,
): MovementSchedule {
  const presentation = current.presentation;
  const perEntity = nciMovements(prior, current, options);
  const total = (pick: (m: NciMovement) => Money): Money =>
    sumMoney(perEntity.map(pick), presentation);

  const opening = total((m) => m.opening);
  const lines: MovementLine[] = [
    { label: "Share of the result for the period", amount: total((m) => m.shareOfResult) },
    { label: "Share of the translation effect", amount: total((m) => m.shareOfTranslation) },
    { label: "Share of other movements in net assets", amount: total((m) => m.shareOfOther) },
    { label: "Arising on acquisition", amount: total((m) => m.arisingOnAcquisition) },
  ].filter((line) => !line.amount.isZero);

  const closing = current.nonControllingInterest;
  const rolledForward = lines.reduce((running, line) => running.plus(line.amount), opening);
  const unexplained = closing.minus(rolledForward);

  return Object.freeze({
    what: "Non-controlling interest",
    opening,
    lines: Object.freeze(lines),
    closing,
    unexplained,
    rolledForward,
    reconciles: unexplained.isZero,
  }) as MovementSchedule;
}

/**
 * The translation reserve, from one reporting date to the next.
 *
 * Unlike the outside stake this one is genuinely additive: the reserve is the
 * sum of the entities' translation adjustments, and each entity's movement is
 * simply this period's adjustment less last period's. There is nothing to
 * apportion and so nothing to round, and `unexplained` should be nil for any
 * group whose entities did not change.
 */
export function translationReserveSchedule(
  prior: Consolidation,
  current: Consolidation,
): MovementSchedule {
  const presentation = current.presentation;
  const zero = Money.zero(presentation);
  const priorByEntity = new Map(
    prior.aggregation.entities.map((c) => [c.entity, c.translationAdjustment] as const),
  );

  const lines: MovementLine[] = [];
  for (const contribution of current.aggregation.entities) {
    const before = priorByEntity.get(contribution.entity) ?? zero;
    const movement = contribution.translationAdjustment.minus(before);
    if (movement.isZero) continue;
    lines.push({
      label: priorByEntity.has(contribution.entity)
        ? `${contribution.entity} — movement on retranslation`
        : `${contribution.entity} — arising in the period`,
      amount: movement,
    });
  }
  for (const [entity, before] of priorByEntity) {
    const stillThere = current.aggregation.entities.some((c) => c.entity === entity);
    if (stillThere || before.isZero) continue;
    lines.push({ label: `${entity} — no longer consolidated`, amount: before.negated() });
  }

  const opening = prior.translationReserve;
  // The reserve is reported as a credit balance; the adjustments are the raw
  // signed figures, so the movement in the reported reserve is their negation.
  const rolledForward = lines.reduce((running, line) => running.plus(line.amount.negated()), opening);
  const closing = current.translationReserve;
  const unexplained = closing.minus(rolledForward);

  return Object.freeze({
    what: "Translation reserve",
    opening,
    lines: Object.freeze(lines.map((l) => Object.freeze({ ...l, amount: l.amount.negated() }))),
    closing,
    unexplained,
    rolledForward,
    reconciles: unexplained.isZero,
  }) as MovementSchedule;
}

export function renderMovementSchedule(schedule: MovementSchedule): string {
  const width = Math.max(
    36,
    ...schedule.lines.map((l) => l.label.length),
  );
  const line = (label: string, amount: Money): string =>
    `  ${label.padEnd(width)}${amount.toDecimalString().padStart(16)}`;
  const out: string[] = [];
  out.push(schedule.what);
  out.push(line("At the start of the period", schedule.opening));
  for (const item of schedule.lines) out.push(line(item.label, item.amount));
  if (!schedule.unexplained.isZero) {
    out.push(line("Not explained by the above", schedule.unexplained));
  }
  out.push(line("At the reporting date", schedule.closing));
  return out.join("\n");
}

export function renderNetAssetsMovements(
  movements: readonly NetAssetsMovement[],
  names: (entity: string) => string,
): string {
  const column = 16;
  const width = Math.max(24, ...movements.map((m) => names(m.entity).length + 6));
  const out: string[] = [];
  out.push("Movement in net assets");
  out.push(
    "Entity".padEnd(width) +
      "Opening".padStart(column) +
      "Currency".padStart(column) +
      "Result".padStart(column) +
      "Other".padStart(column) +
      "Closing".padStart(column),
  );
  out.push("-".repeat(width + column * 5));
  for (const movement of movements) {
    if (!movement.comparable) {
      out.push(
        `${movement.entity} ${names(movement.entity)}`.padEnd(width) +
          "acquired in the period".padStart(column * 4) +
          movement.closing.toDecimalString().padStart(column),
      );
      continue;
    }
    out.push(
      `${movement.entity} ${names(movement.entity)}`.padEnd(width) +
        movement.opening.toDecimalString().padStart(column) +
        movement.translationEffect.toDecimalString().padStart(column) +
        movement.result.toDecimalString().padStart(column) +
        movement.other.toDecimalString().padStart(column) +
        movement.closing.toDecimalString().padStart(column),
    );
  }
  return out.join("\n");
}
