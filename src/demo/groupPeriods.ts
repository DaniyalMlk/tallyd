/**
 * The same group, two years running.
 *
 * The single-date report answers "what does the group look like now". This one
 * answers the question a reader asks straight after: what moved, and why.
 *
 * The check at the end is the point of the whole file. Two figures on the
 * consolidated balance sheet — the outside stake and the translation reserve —
 * are measured directly from the closing position, and two schedules explain
 * how they got there by adding up components measured quite differently: a
 * share of a result translated at an average rate, a share of a currency
 * movement on an opening balance, a residual. Those two routes to the same
 * number have almost nothing in common, so agreeing is meaningful. Where they
 * disagree the difference is printed rather than hidden, because a schedule
 * that quietly plugs its last line is worse than no schedule.
 */

import { Money } from "../money/money.js";
import { GBP } from "../money/currency.js";
import { consolidate } from "../group/consolidate.js";
import {
  compareConsolidations,
  renderComparative,
  type ComparativeConsolidation,
} from "../group/comparative.js";
import { renderMovementSchedule, renderNetAssetsMovements } from "../group/movement.js";
import {
  GROUP_AS_AT,
  GROUP_PRIOR_AS_AT,
  groupAcquisitions,
  groupIntercompany,
  groupLedgers,
  groupPeriod,
  groupPriorPeriod,
  groupRates,
  groupStructure,
} from "./group.js";

/**
 * Consolidate the same books at both year ends.
 *
 * Nothing is carried over from the first to the second. Each entity's ledger is
 * a complete history, so last year's balance sheet is the same file asked a
 * different question — which is why a group that has never prepared a
 * consolidation before can still produce a comparative.
 */
export function comparedGroup(): ComparativeConsolidation {
  const group = groupStructure();
  const ledgers = groupLedgers();
  const rates = groupRates();
  const shared = {
    rates,
    averageMethod: "daily" as const,
    intercompany: groupIntercompany(),
    acquisitions: groupAcquisitions(),
  };
  const prior = consolidate(group, ledgers, {
    ...shared,
    asAt: GROUP_PRIOR_AS_AT,
    period: groupPriorPeriod(),
  });
  const current = consolidate(group, ledgers, {
    ...shared,
    asAt: GROUP_AS_AT,
    period: groupPeriod(),
  });
  return compareConsolidations(prior, current, { rates });
}

export function groupPeriodsReport(): string {
  const compared = comparedGroup();
  const name = (entity: string) => compared.group.get(entity).name;
  const line = (label: string, amount: Money): string =>
    `  ${label.padEnd(46)}${amount.toDecimalString().padStart(16)}`;

  const sections: string[] = [];
  sections.push("The same group, two years running");
  sections.push("=".repeat(72));
  sections.push("");
  sections.push(
    `Consolidated at ${compared.asAt}, with ${compared.comparativeAsAt} beside it. ` +
      `Both come out of the same three ledgers.`,
  );
  sections.push("");

  sections.push("Both columns, and what moved");
  sections.push("-".repeat(72));
  sections.push(renderComparative(compared));
  sections.push("");

  sections.push("Where the movement came from");
  sections.push("-".repeat(72));
  sections.push(renderNetAssetsMovements(compared.netAssets, name));
  sections.push("");
  sections.push(
    "The currency column is what the rate did to the opening balance and nothing else: " +
      "Nord's investment in Systems is held at what was paid for it, so it is left out of that " +
      "column even though it is part of Nord's net assets.",
  );
  sections.push("");

  sections.push("The outside stake, rolled forward");
  sections.push("-".repeat(72));
  sections.push(renderMovementSchedule(compared.nci));
  sections.push("");
  for (const movement of compared.nciByEntity) {
    const entity = compared.group.get(movement.entity);
    sections.push(
      `  ${movement.entity} ${entity.name} — ${entity.nonControlling.toPercentString(4)} held outside`,
    );
    sections.push(line("    opening", movement.opening));
    sections.push(line("    share of the result", movement.shareOfResult));
    sections.push(line("    share of the translation effect", movement.shareOfTranslation));
    sections.push(line("    share of other movements", movement.shareOfOther));
    if (!movement.arisingOnAcquisition.isZero) {
      sections.push(line("    arising on acquisition", movement.arisingOnAcquisition));
    }
    sections.push(line("    closing", movement.closing));
    sections.push("");
  }

  sections.push("The translation reserve, rolled forward");
  sections.push("-".repeat(72));
  sections.push(renderMovementSchedule(compared.translationReserve));
  sections.push("");

  // ------------------------------------------------------------- the check
  sections.push("Does it hang together");
  sections.push("-".repeat(72));
  const zero = Money.zero(GBP);
  const perEntityClosing = compared.nciByEntity.reduce(
    (running, movement) => running.plus(movement.closing),
    zero,
  );
  sections.push(line("Outside stake measured from the balance sheet", compared.nci.closing));
  sections.push(line("Outside stake rolled forward from last year", compared.nci.rolledForward));
  sections.push(line("Difference", compared.nci.unexplained));
  sections.push(line("Same figure, added up entity by entity", perEntityClosing));
  sections.push("");
  sections.push(line("Translation reserve measured directly", compared.translationReserve.closing));
  sections.push(
    line("Translation reserve rolled forward", compared.translationReserve.rolledForward),
  );
  sections.push(line("Difference", compared.translationReserve.unexplained));
  sections.push("");
  for (const movement of compared.netAssets) {
    const rolled = movement.opening
      .plus(movement.translationEffect)
      .plus(movement.result)
      .plus(movement.other);
    sections.push(
      `  ${movement.entity} net assets: opening plus the three components is ` +
        `${rolled.toDecimalString()}, and the balance sheet says ` +
        `${movement.closing.toDecimalString()}${rolled.equals(movement.closing) ? "." : " — THEY DISAGREE"}`,
    );
  }
  sections.push("");
  sections.push(
    compared.sound && perEntityClosing.equals(compared.nci.closing)
      ? "  Two routes to each figure, and they agree."
      : "  TWO ROUTES TO THE SAME FIGURE, AND THEY DO NOT AGREE",
  );

  return sections.join("\n");
}
