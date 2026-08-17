/**
 * The stylesheet, inlined.
 *
 * Design read: this is a tool, not a landing page. Someone opens it with a
 * statement half-reconciled and works down a queue until the bridge reaches
 * zero. So the surface earns its keep by being legible and dense rather than
 * expressive — one typeface, a fixed rem scale, colour reserved for state, and
 * transitions short enough that nobody waits for them.
 *
 * Numerals are tabular everywhere a figure appears. A column of money whose
 * digits do not line up is the fastest way to make an accounting page look
 * wrong to the only people qualified to read it.
 */

export const STYLES = `
:root {
  color-scheme: light;

  --canvas: #fbfbfa;
  --surface: #ffffff;
  --surface-sunken: #f5f4f1;
  --rule: #e6e4df;
  --rule-strong: #d3d0c9;

  --ink: #171613;
  --ink-secondary: #57544c;
  --ink-muted: #85817a;

  --accent: #1f5f9f;
  --accent-soft: #e3eefa;

  --good: #2f6b3a;
  --good-soft: #e8f1e7;
  --warn: #8a5a00;
  --warn-soft: #faf1dc;
  --bad: #97302e;
  --bad-soft: #fbeae9;

  --series-1: #2a78d6;
  --seq-1: #cfe0f4;
  --seq-2: #92bbe8;
  --seq-3: #4f92da;
  --seq-4: #1f5f9f;

  --radius: 12px;
  --radius-small: 6px;
  --pad: 20px;
  --ease: cubic-bezier(0.22, 1, 0.36, 1);

  --font: "Inter var", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI",
    "Helvetica Neue", Arial, sans-serif;
  --mono: "SF Mono", "JetBrains Mono", "Cascadia Mono", ui-monospace, Menlo, monospace;
}

@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --canvas: #131311;
    --surface: #1b1b19;
    --surface-sunken: #232320;
    --rule: #2f2f2b;
    --rule-strong: #454540;
    --ink: #f4f3ef;
    --ink-secondary: #b8b5ac;
    --ink-muted: #8e8b83;
    --accent: #6aa9e8;
    --accent-soft: #1d2c3c;
    --good: #86c08d;
    --good-soft: #1c2a1e;
    --warn: #d9ab55;
    --warn-soft: #2e2716;
    --bad: #e08b88;
    --bad-soft: #33201f;
    --series-1: #3987e5;
    --seq-1: #22334a;
    --seq-2: #2c4d70;
    --seq-3: #386c9f;
    --seq-4: #4a8dcb;
  }
}

* { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--canvas);
  color: var(--ink);
  font-family: var(--font);
  font-size: 15px;
  line-height: 1.55;
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
}

::selection { background: var(--accent-soft); color: var(--ink); }

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-small);
}

.shell {
  max-width: 1180px;
  margin: 0 auto;
  padding: 40px 24px 96px;
}

/* ---------------------------------------------------------------- masthead */

.masthead {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  align-items: baseline;
  justify-content: space-between;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--rule);
}

.masthead h1 {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 620;
  letter-spacing: -0.024em;
}

.masthead p {
  margin: 4px 0 0;
  color: var(--ink-secondary);
  font-size: 0.875rem;
}

.masthead-meta {
  display: flex;
  gap: 24px;
  font-size: 0.8125rem;
  color: var(--ink-secondary);
}

.masthead-meta div span {
  display: block;
  color: var(--ink-muted);
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.07em;
}

.masthead-meta div strong {
  font-weight: 560;
  color: var(--ink);
}

/* ------------------------------------------------------------------ layout */

section { margin-top: 44px; }

h2 {
  margin: 0 0 4px;
  font-size: 1.0625rem;
  font-weight: 600;
  letter-spacing: -0.014em;
}

.section-note {
  margin: 0 0 18px;
  color: var(--ink-secondary);
  font-size: 0.8125rem;
  max-width: 68ch;
}

.panel {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  padding: var(--pad);
}

.split {
  display: grid;
  gap: 20px;
  align-items: start;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
}

@media (max-width: 900px) {
  .split { grid-template-columns: minmax(0, 1fr); }
}

/* ------------------------------------------------------------------ bridge */

.bridge dl {
  margin: 0;
  display: grid;
  grid-template-columns: 1fr auto;
  row-gap: 2px;
  column-gap: 16px;
  font-size: 0.875rem;
}

.bridge dt { color: var(--ink-secondary); }
.bridge dd { margin: 0; font-family: var(--mono); font-size: 0.8125rem; text-align: right; }

.bridge .rule-row {
  grid-column: 1 / -1;
  height: 1px;
  background: var(--rule);
  margin: 10px 0;
}

.bridge dt.lead-row,
.bridge dd.lead-row { font-weight: 600; color: var(--ink); }

.bridge-verdict {
  margin-top: 18px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: var(--radius-small);
  font-size: 0.875rem;
  font-weight: 550;
  transition: background 180ms var(--ease), color 180ms var(--ease);
}

.bridge-verdict[data-state="balanced"] { background: var(--good-soft); color: var(--good); }
.bridge-verdict[data-state="off"] { background: var(--bad-soft); color: var(--bad); }

.bridge-verdict .figure { margin-left: auto; font-family: var(--mono); }

/* ------------------------------------------------------------------ counts */

.counts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  background: var(--rule);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  overflow: hidden;
}

.counts > div {
  background: var(--surface);
  padding: 14px 16px;
}

.counts dt {
  margin: 0;
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--ink-muted);
}

.counts dd {
  margin: 2px 0 0;
  font-size: 1.375rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 620px) {
  .counts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

/* ------------------------------------------------------------------- queue */

.queue { display: flex; flex-direction: column; gap: 12px; }

.match {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  padding: 16px 18px;
  transition: border-color 160ms var(--ease), opacity 200ms var(--ease),
    transform 200ms var(--ease);
}

.match:hover { border-color: var(--rule-strong); }

.match[data-leaving="true"] {
  opacity: 0;
  transform: translateY(-6px);
  pointer-events: none;
}

.match-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}

.match-amount {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 0.9375rem;
  font-weight: 550;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 0.6875rem;
  font-weight: 560;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.badge[data-confidence="exact"],
.badge[data-confidence="high"] { background: var(--good-soft); color: var(--good); }
.badge[data-confidence="medium"] { background: var(--warn-soft); color: var(--warn); }
.badge[data-confidence="low"] { background: var(--bad-soft); color: var(--bad); }

.badge-kind { background: var(--surface-sunken); color: var(--ink-secondary); }

.score { font-family: var(--mono); font-size: 0.75rem; color: var(--ink-muted); }

.pairing {
  margin: 12px 0 0;
  display: grid;
  gap: 6px;
}

.pairing-line {
  display: grid;
  grid-template-columns: 44px 92px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: baseline;
  font-size: 0.8125rem;
}

.pairing-line .who {
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--ink-muted);
}

.pairing-line .when { font-family: var(--mono); font-size: 0.75rem; color: var(--ink-secondary); }
.pairing-line .what { overflow-wrap: anywhere; }
.pairing-line .how-much { font-family: var(--mono); text-align: right; }

@media (max-width: 620px) {
  .pairing-line {
    grid-template-columns: auto 1fr;
    row-gap: 2px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--rule);
  }
  .pairing-line:last-child { border-bottom: 0; padding-bottom: 0; }
  .pairing-line .who { grid-column: 1; }
  .pairing-line .when { grid-column: 2; }
  .pairing-line .what { grid-column: 1 / -1; }
  .pairing-line .how-much { grid-column: 1 / -1; text-align: left; }
}

.reasons {
  margin: 12px 0 0;
  padding: 10px 12px;
  background: var(--surface-sunken);
  border-radius: var(--radius-small);
  list-style: none;
  display: grid;
  gap: 3px;
  font-size: 0.75rem;
  color: var(--ink-secondary);
}

.reasons li::before {
  content: "";
  display: inline-block;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--rule-strong);
  margin-right: 8px;
  vertical-align: 2px;
}

.actions { margin-top: 14px; display: flex; gap: 8px; }

button {
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 540;
  padding: 6px 14px;
  border-radius: var(--radius-small);
  border: 1px solid var(--rule-strong);
  background: var(--surface);
  color: var(--ink);
  cursor: pointer;
  transition: background 140ms var(--ease), border-color 140ms var(--ease),
    color 140ms var(--ease), transform 90ms var(--ease);
}

button:hover:not(:disabled) { background: var(--surface-sunken); border-color: var(--ink-muted); }
button:active:not(:disabled) { transform: scale(0.985); }
button:disabled { opacity: 0.45; cursor: not-allowed; }

button.primary { background: var(--ink); color: var(--canvas); border-color: var(--ink); }
button.primary:hover:not(:disabled) { background: var(--ink-secondary); border-color: var(--ink-secondary); }

/* ------------------------------------------------------------------ tables */

table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }

th {
  text-align: left;
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--ink-muted);
  font-weight: 560;
  padding: 0 12px 8px 0;
  border-bottom: 1px solid var(--rule);
}

th:last-child, td:last-child { padding-right: 0; }

td {
  padding: 7px 12px 7px 0;
  border-bottom: 1px solid var(--rule);
  vertical-align: baseline;
}
tbody tr:last-child td { border-bottom: 0; }

td.num, th.num { text-align: right; font-family: var(--mono); }
td.when { font-family: var(--mono); color: var(--ink-secondary); white-space: nowrap; }

tbody tr[data-clickable="true"] { cursor: pointer; }
tbody tr[data-clickable="true"]:hover td { background: var(--surface-sunken); }
tbody tr[aria-selected="true"] td { background: var(--accent-soft); }

.negative { color: var(--bad); }

/* -------------------------------------------------------------- disclosure */

details { border-top: 1px solid var(--rule); }
details:last-of-type { border-bottom: 1px solid var(--rule); }

summary {
  cursor: pointer;
  padding: 12px 0;
  font-size: 0.875rem;
  font-weight: 550;
  list-style: none;
  display: flex;
  align-items: center;
  gap: 10px;
}

summary::-webkit-details-marker { display: none; }

summary .chevron {
  width: 8px;
  height: 8px;
  border-right: 1.5px solid var(--ink-muted);
  border-bottom: 1.5px solid var(--ink-muted);
  transform: rotate(-45deg);
  transition: transform 160ms var(--ease);
}

details[open] summary .chevron { transform: rotate(45deg); }

summary .tally {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 0.75rem;
  color: var(--ink-muted);
}

details > div { padding-bottom: 16px; }

/* ------------------------------------------------------------------ charts */

.chart { position: relative; }
.chart svg { display: block; width: 100%; height: auto; overflow: visible; }
.chart .axis text { font-size: 11px; fill: var(--ink-muted); font-family: var(--mono); }
.chart .grid line { stroke: var(--rule); stroke-width: 1; }
.chart .series-line { fill: none; stroke: var(--series-1); stroke-width: 2; stroke-linejoin: round; }
.chart .series-area { fill: var(--series-1); opacity: 0.08; }
.chart .marker { fill: var(--series-1); stroke: var(--surface); stroke-width: 2; }
.chart .crosshair { stroke: var(--rule-strong); stroke-width: 1; stroke-dasharray: 3 3; }

.chart .bar { transition: opacity 140ms var(--ease); }
.chart:hover .bar { opacity: 0.55; }
.chart .bar:hover { opacity: 1; }
.chart .bar-label { font-size: 12px; fill: var(--ink-secondary); font-family: var(--mono); }

.tooltip {
  position: absolute;
  pointer-events: none;
  background: var(--ink);
  color: var(--canvas);
  padding: 5px 9px;
  border-radius: var(--radius-small);
  font-size: 0.75rem;
  font-family: var(--mono);
  white-space: nowrap;
  opacity: 0;
  transform: translate(-50%, -130%);
  transition: opacity 120ms var(--ease);
  z-index: 5;
}

.tooltip[data-visible="true"] { opacity: 1; }

/*
 * An SVG with a viewBox scales its text down with everything else, so a chart
 * that is legible at 640px wide has 5px axis labels on a phone. The fix is to
 * draw the text larger in viewBox units at narrow widths, not to shrink the
 * chart.
 */
@media (max-width: 700px) {
  .chart .axis text { font-size: 20px; }
  .chart .bar-label { font-size: 17px; }
}

/* --------------------------------------------------------------- decisions */

/*
 * The one authored moment on the page. The bar is out of the way until the
 * first decision exists, then it arrives from below — the direction it will
 * leave in — and stays put for the rest of the session. Everything else here
 * moves only in response to a click.
 */
.decision-bar {
  position: fixed;
  left: 50%;
  bottom: 20px;
  z-index: 20;
  width: min(760px, calc(100vw - 32px));
  translate: -50% 0;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px 12px 18px;
  background: var(--surface);
  border: 1px solid var(--rule-strong);
  border-radius: 14px;
  box-shadow: 0 1px 2px rgba(23, 22, 19, 0.06), 0 12px 32px -12px rgba(23, 22, 19, 0.28);
  transition: opacity 260ms var(--ease), transform 260ms var(--ease),
    visibility 0s linear 260ms;
  opacity: 0;
  transform: translateY(14px);
  visibility: hidden;
}

.decision-bar[data-open="true"] {
  opacity: 1;
  transform: translateY(0);
  visibility: visible;
  transition-delay: 0s;
}

.decision-bar .tally-text {
  font-size: 0.8125rem;
  color: var(--ink-secondary);
  min-width: 0;
}

.decision-bar .tally-text strong {
  color: var(--ink);
  font-weight: 560;
  font-variant-numeric: tabular-nums;
}

.decision-bar .bar-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

@media (max-width: 620px) {
  .decision-bar { flex-wrap: wrap; }
  .decision-bar .bar-actions { margin-left: 0; width: 100%; }
  .decision-bar .bar-actions button { flex: 1; }
}

.decided-list { display: flex; flex-direction: column; }

.decided-row {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 14px;
  padding: 10px 2px;
  border-bottom: 1px solid var(--rule);
  font-size: 0.8125rem;
}

.decided-row:last-child { border-bottom: 0; }

.decided-row .verdict {
  font-size: 0.6875rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-weight: 560;
  padding: 2px 8px;
  border-radius: 999px;
}

.decided-row .verdict[data-verdict="accepted"] { background: var(--good-soft); color: var(--good); }
.decided-row .verdict[data-verdict="rejected"] { background: var(--bad-soft); color: var(--bad); }

.decided-row .what {
  color: var(--ink-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.decided-row .when { font-family: var(--mono); font-size: 0.75rem; color: var(--ink-muted); }
.decided-row .how-much { font-family: var(--mono); font-size: 0.75rem; }
.decided-row .how-much.negative { color: var(--bad); }

.decided-row button { padding: 3px 10px; font-size: 0.75rem; }

/* ----------------------------------------------------------------- implied */

.implied-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto minmax(0, 22ch);
  align-items: baseline;
  gap: 14px;
  padding: 9px 2px;
  border-bottom: 1px solid var(--rule);
  font-size: 0.8125rem;
}

.implied-row:last-child { border-bottom: 0; }
.implied-row .when { font-family: var(--mono); font-size: 0.75rem; color: var(--ink-muted); }
.implied-row .what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.implied-row .how-much { font-family: var(--mono); font-size: 0.75rem; }
.implied-row .how-much.negative { color: var(--bad); }

.implied-row .lands {
  font-size: 0.75rem;
  color: var(--ink-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.implied-row .lands code {
  font-family: var(--mono);
  font-size: 0.6875rem;
  color: var(--ink);
}

.implied-row[data-outcome="unclassified"] .lands { color: var(--warn); }
.implied-row[data-outcome="skip"] .lands { color: var(--ink-muted); }

.implied-total {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--rule-strong);
  font-size: 0.8125rem;
  font-weight: 550;
}

.implied-total .figure { font-family: var(--mono); white-space: nowrap; }

@media (max-width: 700px) {
  .implied-row { grid-template-columns: minmax(0, 1fr) auto; row-gap: 2px; }
  .implied-row .when { grid-column: 1 / -1; }
  .implied-row .lands { grid-column: 1 / -1; }
}

/* ------------------------------------------------------------------- empty */

.empty {
  padding: 22px 18px;
  border: 1px dashed var(--rule-strong);
  border-radius: var(--radius);
  color: var(--ink-secondary);
  font-size: 0.8125rem;
  text-align: center;
}

.empty strong { display: block; color: var(--ink); font-weight: 560; margin-bottom: 3px; }

/* ------------------------------------------------------------------ footer */

footer {
  margin-top: 56px;
  padding-top: 18px;
  border-top: 1px solid var(--rule);
  color: var(--ink-muted);
  font-size: 0.75rem;
  display: flex;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition-duration: 1ms !important;
    animation-duration: 1ms !important;
  }
}
`;
