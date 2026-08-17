/**
 * Assembling the page.
 *
 * One file, no network. Styles and script are inlined, the data is embedded as
 * JSON, and nothing is fetched — because the person who most needs to look at a
 * reconciliation is often the one who cannot install anything, and a dashboard
 * that needs a CDN is a dashboard that fails on a train.
 *
 * Escaping is done here rather than trusted anywhere: bank descriptors are
 * attacker-adjacent text in the sense that matters, which is that they contain
 * whatever the payer typed into a reference field.
 */

import type { DashboardData, LineView, MatchView } from "./model.js";
import { STYLES } from "./styles.js";
import { CLIENT_SCRIPT } from "./script.js";
import { cashPositionChart, confidenceChart } from "./charts.js";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * JSON safe to sit inside a `<script>` element.
 *
 * `</script>` anywhere in the data would close the block early — a narration
 * reading "see </script> for details" is unlikely but the failure is total, and
 * the fix is three replacements.
 */
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const amountClass = (line: { amount: { minor: number } }): string =>
  line.amount.minor < 0 ? "how-much negative" : "how-much";

function pairingLine(line: LineView): string {
  return `<div class="pairing-line">
      <span class="who">${line.side === "book" ? "Ledger" : "Bank"}</span>
      <span class="when">${escapeHtml(line.date)}</span>
      <span class="what">${escapeHtml(line.description)}</span>
      <span class="${amountClass(line)}">${escapeHtml(line.amount.text)}</span>
    </div>`;
}

const KIND_LABEL: Record<MatchView["kind"], string> = {
  "one-to-one": "1:1",
  "one-to-many": "1:N",
  "many-to-one": "N:1",
};

function matchCard(match: MatchView, actionable: boolean): string {
  const reasons =
    match.reasons.length === 0
      ? ""
      : `<ul class="reasons">${match.reasons
          .map((reason) => `<li>${escapeHtml(reason)}</li>`)
          .join("")}</ul>`;

  const actions = actionable
    ? `<div class="actions">
        <button type="button" class="primary" data-action="accept" data-match-id="${escapeHtml(match.id)}">Accept match</button>
        <button type="button" data-action="reject" data-match-id="${escapeHtml(match.id)}">Not a match</button>
      </div>`
    : "";

  return `<article class="match" data-match-id="${escapeHtml(match.id)}">
    <div class="match-head">
      <span class="badge" data-confidence="${escapeHtml(match.confidence)}">${escapeHtml(match.confidence)}</span>
      <span class="badge badge-kind">${escapeHtml(KIND_LABEL[match.kind])}</span>
      <span class="score">${match.score.toFixed(3)}</span>
      <span class="match-amount">${escapeHtml(match.amount.text)}</span>
    </div>
    <div class="pairing">
      ${match.statement.map(pairingLine).join("")}
      ${match.book.map(pairingLine).join("")}
    </div>
    ${reasons}
    ${actions}
  </article>`;
}

function accountsTable(data: DashboardData): string {
  if (data.accounts.length === 0) {
    return `<div class="empty"><strong>No chart</strong>This ledger was loaded without a chart of accounts.</div>`;
  }
  const rows = data.accounts
    .map(
      (account) => `<tr data-account="${escapeHtml(account.code)}" data-clickable="true" tabindex="0" role="button" aria-selected="false">
        <td class="when">${escapeHtml(account.code)}</td>
        <td style="padding-left:${account.depth * 14}px">${escapeHtml(account.name)}</td>
        <td class="when">${escapeHtml(account.type)}</td>
        <td class="num${account.balance.minor < 0 ? " negative" : ""}">${escapeHtml(account.balance.text)}</td>
      </tr>`,
    )
    .join("");

  return `<table>
    <thead><tr><th>Code</th><th>Account</th><th>Type</th><th class="num">Balance</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

export function renderDashboard(data: DashboardData): string {
  const title = `Bank reconciliation — ${data.account} ${data.accountName}`;

  const matchedCards =
    data.matched.length === 0
      ? `<div class="empty"><strong>Nothing matched yet</strong>The matcher found no pair confident enough to accept on its own.</div>`
      : data.matched.map((match) => matchCard(match, false)).join("");

  const queueCards = data.suggested.map((match) => matchCard(match, true)).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="shell">

  <header class="masthead">
    <div>
      <h1>Bank reconciliation</h1>
      <p>${escapeHtml(data.account)} ${escapeHtml(data.accountName)} · ${escapeHtml(data.period.from)} to ${escapeHtml(data.period.to)}</p>
    </div>
    <div class="masthead-meta">
      <div><span>Currency</span><strong>${escapeHtml(data.currency)}</strong></div>
      <div><span>Statement</span><strong>${escapeHtml(data.statementFormat.toUpperCase())}</strong></div>
      <div><span>Trial balance</span><strong>${data.trialBalanceBalanced ? "Agrees" : "Does not agree"}</strong></div>
    </div>
  </header>

  <p id="live-region" class="visually-hidden" role="status" aria-live="polite"></p>

  <section>
    <h2>Where it stands</h2>
    <p class="section-note">The bridge recomputes as you work: an undecided suggestion counts as outstanding on both sides, because until someone confirms it, it is not evidence.</p>
    <div class="split">
      <div class="panel bridge">
        <dl id="bridge-list"></dl>
        <div class="bridge-verdict" id="bridge-verdict" data-state="off">
          <span class="label">Reconciled</span>
          <span class="figure">0.00</span>
        </div>
      </div>
      <div>
        <dl class="counts">
          <div><dt>Matched</dt><dd id="count-matched">0</dd></div>
          <div><dt>To review</dt><dd id="count-review">0</dd></div>
          <div><dt>Ledger only</dt><dd id="count-book">0</dd></div>
          <div><dt>Bank only</dt><dd id="count-bank">0</dd></div>
        </dl>
        <div class="panel" style="margin-top:20px">
          <h2 style="font-size:0.875rem">Match confidence</h2>
          <p class="section-note" style="margin-bottom:12px">How much of this the matcher actually knew.</p>
          ${confidenceChart(data.confidence)}
        </div>
      </div>
    </div>
  </section>

  <section>
    <h2>Review queue</h2>
    <p class="section-note">Pairs the matcher believes but will not post on its own. Accepting one moves it into the matched set and updates the bridge above.</p>
    <div class="queue" id="queue">${queueCards}</div>
  </section>

  <section id="decided-section" hidden>
    <h2>Decided</h2>
    <p class="section-note">What you have said so far. Nothing is written anywhere until you export it, and any of these can be taken back until then.</p>
    <div class="panel"><div class="decided-list" id="decided-list"></div></div>
  </section>

  <section>
    <h2>Leftovers</h2>
    <p class="section-note">What each side has that the other does not. These are the timing differences and the entries nobody has booked.</p>
    <div class="split">
      <div class="panel">
        <h2 style="font-size:0.875rem">In the books, not on the statement</h2>
        <div id="leftover-book" style="margin-top:12px"></div>
      </div>
      <div class="panel">
        <h2 style="font-size:0.875rem">On the statement, not in the books</h2>
        <div id="leftover-bank" style="margin-top:12px"></div>
      </div>
    </div>
  </section>

  <section id="implied-section">
    <h2>What this implies</h2>
    <p class="section-note">The entries these statement lines would need if nothing in the books explains them. Rejecting a suggestion adds one here; accepting it takes one away. Run <code>tallyd post</code> to book them.</p>
    <div class="panel" id="implied"></div>
  </section>

  <section>
    <h2>Cash position</h2>
    <p class="section-note">The balance of ${escapeHtml(data.account)} after every day it moved.</p>
    <div class="panel">${cashPositionChart(data.cashPosition, { exponent: data.exponent, symbol: data.currencySymbol })}</div>
  </section>

  <section>
    <h2>Accepted matches</h2>
    <details>
      <summary><span class="chevron"></span>Matched outright<span class="tally" id="matched-tally">0</span></summary>
      <div class="queue">${matchedCards}</div>
    </details>
  </section>

  <section>
    <h2>The ledger</h2>
    <p class="section-note">Every account that has been posted to. Choose one to read its postings.</p>
    <div class="split">
      <div class="panel">${accountsTable(data)}</div>
      <div class="panel" id="postings"></div>
    </div>
  </section>

  <footer>
    <span>Generated by ${escapeHtml(data.generatedFor)} — this file is self-contained and works offline.</span>
    <span>Export decisions, then <code>tallyd learn</code> to teach the matcher and <code>tallyd post</code> to book what is left.</span>
  </footer>

</div>

<div class="decision-bar" id="decision-bar" data-open="false" role="region" aria-label="Decisions to export">
  <span class="tally-text" id="decision-tally">No decisions yet</span>
  <span class="bar-actions">
    <button type="button" data-action="undo-last">Undo last</button>
    <button type="button" data-action="copy-decisions">Copy</button>
    <button type="button" class="primary" data-action="export-decisions">Export decisions</button>
  </span>
</div>
<script>window.__TALLYD__ = ${embedJson(data)};</script>
<script>${CLIENT_SCRIPT}</script>
</body>
</html>
`;
}
