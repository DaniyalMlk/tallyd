/**
 * The worked quarter, printed: what is exposed, what the close does about it,
 * and what settlement turns out to realise.
 *
 * The last section is the one worth reading. It adds the unrealised movement
 * booked at the March close to the realised movement booked on settlement, and
 * checks the total against the rate move itself. If those two ever disagreed,
 * something would be being counted twice or not at all.
 */

import { Money, sumMoney } from "../money/money.js";
import { GBP } from "../money/currency.js";
import { renderTrialBalance, trialBalance } from "../ledger/trialBalance.js";
import { exposures, renderExposures } from "../fx/exposure.js";
import { applyRevaluation, renderRevaluation, revalue } from "../fx/revaluation.js";
import { settleForeignItem } from "../fx/settlement.js";
import { foreignLedger, foreignRates } from "./foreign.js";

export function foreignReport(): string {
  const rates = foreignRates();
  const opening = foreignLedger();
  const sections: string[] = [];

  sections.push("A quarter with two foreign-currency counterparties");
  sections.push("=".repeat(64));
  sections.push("");
  sections.push(renderExposures(exposures(opening), "GBP"));
  sections.push("");

  // ------------------------------------------------------------- the close
  const close = revalue(opening, { asAt: "2026-03-31", rates });
  const revalued = applyRevaluation(opening, { asAt: "2026-03-31", rates });
  sections.push(renderRevaluation(close));
  sections.push("");

  // -------------------------------------------------------- and settlement
  const paid = settleForeignItem(revalued, {
    id: "RCT-2026-021",
    date: "2026-04-20",
    account: "1131",
    bankAccount: "1110",
    reference: "INV-021",
    rates,
  });
  const afterReceipt = revalued.post(paid.entry);
  const supplier = settleForeignItem(afterReceipt, {
    id: "PMT-2026-221",
    date: "2026-04-20",
    account: "2101",
    bankAccount: "1110",
    rates,
  });
  const settled = afterReceipt.post(supplier.entry);

  sections.push("Settlement on 2026-04-20");
  sections.push("-".repeat(64));
  sections.push(
    `  INV-021   ${paid.settled.toString().padStart(14)}  carried at ` +
      `${paid.carriedAt.toDecimalString().padStart(8)}  received ` +
      `${paid.received.toDecimalString().padStart(8)}  realised ` +
      `${paid.realised.toDecimalString().padStart(7)}`,
  );
  sections.push(
    `  BILL-221  ${supplier.settled.toString().padStart(14)}  carried at ` +
      `${supplier.carriedAt.toDecimalString().padStart(8)}  paid     ` +
      `${supplier.received.toDecimalString().padStart(8)}  realised ` +
      `${supplier.realised.toDecimalString().padStart(7)}`,
  );
  sections.push("");

  // ------------------------------------------------- the arithmetic checked
  const gain = settled.accountBalance("4400", "GBP").natural;
  const loss = settled.accountBalance("5950", "GBP").natural;
  const net = gain.minus(loss);

  // What the rate move was worth, computed from the transactions directly and
  // without reference to any of the entries above.
  const direct = sumMoney(
    [
      // INV-014: 1,000 EUR still outstanding, 0.8400 -> 0.8600.
      Money.parse("20.00", GBP),
      // INV-021: 500 EUR settled, 0.8500 -> 0.8700.
      Money.parse("10.00", GBP),
      // BILL-221: 500 USD settled, 0.7800 -> 0.7600, on a liability.
      Money.parse("10.00", GBP),
    ],
    GBP,
  );

  sections.push("What the rate move came to");
  sections.push("-".repeat(64));
  sections.push(`  Exchange gain            ${gain.toDecimalString().padStart(10)}`);
  sections.push(`  Exchange loss            ${loss.toDecimalString().padStart(10)}`);
  sections.push(`  Net                      ${net.toDecimalString().padStart(10)}`);
  sections.push(`  Expected from the rates  ${direct.toDecimalString().padStart(10)}`);
  sections.push(
    net.equals(direct)
      ? "  Counted once: the unrealised and realised halves add up."
      : `  MISMATCH: out by ${net.minus(direct).toDecimalString()}`,
  );
  sections.push("");

  const remaining = exposures(settled);
  sections.push(renderExposures(remaining, "GBP"));
  sections.push("");
  sections.push(renderTrialBalance(trialBalance(settled, { currency: GBP })));

  return sections.join("\n");
}
