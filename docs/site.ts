/**
 * The documentation site, generated from the engine rather than written beside it.
 *
 * Three rules decide what is allowed on the page.
 *
 * **Every figure comes from code that runs.** The evidence table is rendered
 * from `src/demo/evidence.ts` — the same gate the README quotes, which throws
 * rather than prints when a figure leaves the band it promises — and the counts
 * are read off the chart of accounts and the package's own export list.
 * Nothing here is a number somebody typed, because a number typed on a page is
 * a number that will be wrong in a month. `tests/docs.test.ts` fails in both
 * directions if that stops being true.
 *
 * **The dashboard is the dashboard.** Not a screenshot and not a mock-up: the
 * page embeds the real artefact, built at publish time from generated books
 * with their answer key. It already inlines its styles, its script and its
 * data and fetches nothing, so putting it on a website needs no bundler and no
 * server — which is the same property that lets it open from a file path on a
 * machine with no toolchain, demonstrated rather than claimed.
 *
 * **The palette is the dashboard's.** `src/dashboard/styles.ts` already
 * settled it, down to the dark scheme, so the landing page inherits those
 * values exactly and the page and the thing it is about read as one piece of
 * work rather than as a product site wrapped around an application.
 *
 * The site is two files plus the embedded dashboard, and `site/` is
 * gitignored: the repository holds this generator, not its output.
 */

import * as tallyd from "../src/index.js";
import { standardChart } from "../src/accounts/index.js";
import { evidence, evidenceReport } from "../src/demo/evidence.js";
import type { ReviewDashboard } from "./dashboard.js";

/** The published name, which is also the repository's name. */
export const PACKAGE = "tallyd";
export const SOURCE = "https://github.com/DaniyalMlk/tallyd";

/** Where the dashboard is published relative to the landing page. */
export const DASHBOARD = "review/";

/** The file the dashboard is written to inside {@link DASHBOARD}. */
export const DASHBOARD_FILE = "index.html";

/** Counts the page quotes, each read off the thing it is a count of. */
export interface Counts {
  /** Accounts in the standard chart. */
  readonly accounts: number;
  /** Names the package exports. */
  readonly exports: number;
}

export function counts(): Counts {
  return {
    accounts: standardChart().size,
    exports: Object.keys(tallyd).length,
  };
}

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `` `x` `` to `<code>x</code>`, after escaping. */
function code(text: string): string {
  return text.replace(/`([^`]+)`/g, (_, inner: string) => `<code>${inner}</code>`);
}

/**
 * The markdown rows the evidence gate renders, as cells.
 *
 * The gate owns the rows; this only changes the delimiters. Backticks become
 * `<code>` because the gate writes its labels for the README, and a label that
 * reads `` `tallyd learn` `` on the front page should read as code here too.
 */
export function evidenceRows(report: string): readonly (readonly string[])[] {
  return report
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| ---"))
    .map((line) =>
      line
        .slice(1, -1)
        .split(" | ")
        .map((cell) => cell.trim()),
    );
}

function evidenceTable(report: string): string {
  const [header, ...body] = evidenceRows(report);
  const head = (header ?? []).map((cell) => `<th>${code(esc(cell))}</th>`).join("");
  const lines = body
    .map((row) => `<tr>${row.map((cell) => `<td>${code(esc(cell))}</td>`).join("")}</tr>`)
    .join("\n");
  return `<table class="evidence">\n<thead><tr>${head}</tr></thead>\n<tbody>\n${lines}\n</tbody>\n</table>`;
}

function shell(body: string, description: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tallyd &middot; double-entry books that reconcile themselves</title>
<meta name="description" content="${esc(description)}">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%231f5f9f'/%3E%3Crect x='3' y='4' width='10' height='1.5' fill='white'/%3E%3Crect x='3' y='7.25' width='10' height='1.5' fill='white'/%3E%3Crect x='3' y='11.5' width='10' height='1.5' fill='white' opacity='0.55'/%3E%3C/svg%3E">
<link rel="stylesheet" href="style.css">
</head>
<body>
${body}
</body>
</html>
`;
}

/**
 * The landing page.
 *
 * It leads with the claim the design is actually betting on. Every
 * bookkeeping engine says its books balance; what is unusual here is that the
 * statement is exact rather than approximate, and the place to prove it is the
 * one place a rounding plug would otherwise hide — a consolidation of three
 * companies kept in three currencies, where the translation difference has to
 * land somewhere and is accounted for by what went into it rather than by
 * whatever made the page add up.
 */
function landing(
  report: string,
  measured: ReturnType<typeof evidence>,
  size: Counts,
  dashboard: ReviewDashboard,
): string {
  const { accuracy, index, learning, exact } = measured;
  const largest = index[index.length - 1];
  if (largest === undefined) throw new Error("the index sweep measured nothing");
  const kilobytes = Math.round(dashboard.html.length / 1024);

  return shell(
    `<header class="masthead col--wide">
  <a class="mark" href="./"><span class="mark__glyph" aria-hidden="true"></span>tallyd</a>
  <nav class="masthead__nav">
    <a href="#review">The dashboard</a>
    <a href="#evidence">What is checked</a>
    <a href="#install">Install</a>
    <a href="${esc(SOURCE)}">Source</a>
  </nav>
</header>

<main>

<section class="lede col">
  <h1>A trial balance either balances or it does&nbsp;not.</h1>
  <p class="standfirst">Double-entry bookkeeping, bank reconciliation and group
  consolidation in TypeScript, with no runtime dependencies. Every amount is an
  integer number of minor units, so there is no tolerance to choose and no
  rounding plug to hide behind &mdash; and the reconciliation that follows is
  scored against generated books that come with their own answer key, rather
  than against the matcher&rsquo;s opinion of itself.</p>
  <p class="actions">
    <a class="cta" href="${esc(DASHBOARD)}">Open the dashboard</a>
    <a class="plain" href="${esc(SOURCE)}">Read the source</a>
  </p>
</section>

<section class="claim">
  <div class="claim__inner col--wide">
    <div class="claim__figures">
      <p class="claim__figure"><strong>${esc(exact.groupResidual)}</strong><span>unaccounted for, consolidating three companies in three currencies</span></p>
      <p class="claim__figure"><strong>${accuracy.wrong}</strong><span>wrong matches over ${accuracy.seeds} periods and ${accuracy.links.toLocaleString("en-GB")} links</span></p>
      <p class="claim__figure"><strong>${largest.ratio.toFixed(0)}&times;</strong><span>fewer candidate pairs scored than a matcher that scored them all</span></p>
    </div>
    <p class="claim__detail">The residual is the interesting one. Three sets of
    books kept in three currencies have to be translated at different rates and
    the difference has to go <em>somewhere</em>; it goes to the translation
    reserve, and the reserve is accounted for by the two things that are in it
    &mdash; the entities&rsquo; own translation adjustments and the exchange
    difference on goodwill, which sits in no entity&rsquo;s books because
    goodwill exists only at the group level. Not balanced to a tolerance:
    balanced, to the minor unit.</p>
  </div>
</section>

<section id="review" class="review">
  <div class="review__intro col">
    <h2>The dashboard, running</h2>
    <p>This is the artefact, not a picture of it. It was generated when this
    page was built &mdash; a year of books from the generator, reconciled
    against the statement those books produced: ${dashboard.bookLines} cash
    movements against ${dashboard.statementLines} statement lines,
    ${dashboard.matched} of them paired outright, ${dashboard.toReview} queued
    for review and ${dashboard.unexplained} the books never saw. It is one
    HTML file of ${kilobytes}&nbsp;KB with its styles, its script and its data
    inlined and nothing fetched, which is why it can sit in an iframe on a
    static site and why it opens from a file path on a machine with no network
    and no toolchain &mdash; the situation the person who most needs to read a
    reconciliation is usually in. It is also why it is ${kilobytes}&nbsp;KB:
    every posting is in the file. That trade is stated in
    ${code("`ROADMAP.md`")} rather than hidden.</p>
    <p>It is not a rendering of the command line&rsquo;s output. Accept a
    suggestion and it moves into the matched set and the bridge recomputes in
    front of you; reject one and both lines go back to the leftovers. An
    undecided suggestion counts as outstanding on <em>both</em> sides, so the
    arithmetic stays honest about what has not been confirmed. Work the queue
    and press <em>Export decisions</em> &mdash; the file it hands back is the
    format ${code("`tallyd learn`")} reads, and it is the only new information
    in the whole cycle: a person asserting which counterparties are the same
    counterparty.</p>
    <p class="review__hint">What that assertion is worth, measured: a
    counterparty confirmed once lifted recall from
    ${(learning.coldRecall * 100).toFixed(1)}% to
    ${(learning.warmRecall * 100).toFixed(1)}% in the next period&rsquo;s
    unrelated books, and shortened the queue from ${learning.coldQueue} to
    ${learning.warmQueue}, with precision still
    ${learning.warmPrecision.toFixed(3)}.</p>
  </div>
  <div class="review__frame">
    <iframe src="${esc(DASHBOARD)}" title="tallyd, reconciling a generated set of books"
            loading="lazy" referrerpolicy="no-referrer"></iframe>
  </div>
  <p class="review__fallback col"><a href="${esc(DASHBOARD)}">Open the
  dashboard in its own tab</a> &mdash; it wants a window wider than a
  phone.</p>
</section>

<section id="evidence" class="evidence-section col--wide">
  <h2>What is checked, and against what</h2>
  <p>A reconciliation engine is easy to describe and hard to believe: every one
  of them claims to match a bank statement against a set of books. The question
  a reader actually has is how often it is right, how often it is wrong, and
  what happens to the lines it cannot explain. So here is what was measured.
  Every figure in this table is produced by
  ${code("`npm run demo:evidence`")}, which runs in CI and throws rather than
  prints if any of them leaves the band stated &mdash; and it is the same gate
  that renders this page, so the page cannot drift from the code either.</p>
  ${evidenceTable(report)}
  <p class="aside"><strong>The books come with an answer key.</strong> The
  generator builds a set of books and records which statement line each
  movement is supposed to pair with, so the matcher is scored against truth
  rather than against its own confidence. ${accuracy.seeds} unrelated periods,
  because one dataset proves nothing: a matcher tuned on a single set of books
  scores well on it by construction. The worst period is what is quoted, not
  the mean &mdash; a mean would hide the month it did badly, which is the month
  a reader cares about.</p>
  <p class="aside"><strong>The selectivity row is a count, not a
  duration.</strong> Milliseconds are a statement about the machine they were
  measured on and can be asserted nowhere else. The number of candidate pairs
  the amount-and-date index lets through to text scoring is a property of the
  algorithm and is the same everywhere &mdash; and text similarity is the
  expensive part, so the pairs that never reach it are the whole of the
  performance story.</p>
  <p class="aside"><strong>Precision never falls below
  ${accuracy.worstPrecision.toFixed(3)}, and that is deliberate.</strong> A
  matcher that guesses is worse than one that asks: a wrong match posts an
  entry against the wrong counterparty and nobody looks at it again, where an
  unmatched line stays on the bridge until somebody deals with it. So recall is
  the figure allowed to move and precision is not, and the review queue is
  where the difference between the two goes.</p>
</section>

<section id="install" class="install col">
  <h2>The first minute</h2>
  <pre><code>npm install ${esc(PACKAGE)}</code></pre>
  <pre><code>npx ${esc(PACKAGE)} generate --out books
npx ${esc(PACKAGE)} dashboard -l books/books.json -s books/statement.csv -a 1110 -o review.html</code></pre>
  <p>That writes a year of books with their statement, reconciles the two, and
  leaves you the page above with your own data in it. Node 20.19 or newer. The
  package ships compiled JavaScript and type declarations, exports
  ${size.exports} names, and has no runtime dependencies.</p>
  <pre><code>import { Ledger, standardChart, consolidate } from "${esc(PACKAGE)}";</code></pre>
  <p class="aside">Until the trusted publisher is registered on the registry,
  the install line is the one thing on this page that does not work yet, and it
  installs from source in the meantime:
  ${code("`git clone " + SOURCE + ".git && npm ci`")}.</p>
</section>

<section class="covers col">
  <h2>What is in it</h2>
  <p>A ledger whose entries cannot unbalance it and a chart of
  ${size.accounts} accounts with the tree rules enforced rather than assumed.
  Statement import from CSV and OFX, with duplicate detection. A matcher that
  pairs one line against one, one against many and many against one, indexed on
  amount and date and scored on text, with a counterparty memory that learns
  from what a reviewer confirmed. Ageing, open items, settlement and
  revaluation in other currencies. Income statement, balance sheet and trial
  balance, with comparatives and movements, readable in a presentation currency
  that is not the one the books are kept in. Group consolidation: control and
  ownership treated as the different questions they are, intercompany balances
  and trading eliminated, unrealised profit on intragroup stock provided for
  against the seller, goodwill measured in the acquired entity&rsquo;s own
  currency and retranslated, companies bought and sold part-way through a year,
  and movement schedules for the outside stake, the translation reserve and
  goodwill.</p>
  <p>The reasoning is in the source rather than in a wiki. Every module says
  which treatment it implements and why that one rather than the alternative,
  which is the part of an accounting engine that is actually hard &mdash; and
  ${code("`ROADMAP.md`")} keeps a list of what is <em>not</em> modelled, which
  is the other part.</p>
</section>

</main>

<footer class="foot col--wide">
  <p>tallyd, published as ${code("`" + PACKAGE + "`")}. Built
  from the engine&rsquo;s own evidence gate, so no figure on this page was typed
  by hand. <a href="${esc(SOURCE)}">Source</a>.</p>
</footer>
`,
    "tallyd is double-entry bookkeeping, bank reconciliation and group " +
      "consolidation in TypeScript: exact integer money, a matcher scored " +
      "against generated books with an answer key, and a self-contained " +
      "review dashboard.",
  );
}

/**
 * The stylesheet, inheriting the dashboard's palette so the two read as one thing.
 *
 * The tokens are `src/dashboard/styles.ts`'s, unchanged, including its dark
 * scheme: a near-white canvas, hairlines rather than shadows, one blue accent
 * used only where it carries meaning, and tabular numerals wherever a figure
 * appears. A column of money whose digits do not line up is the fastest way to
 * make an accounting page look wrong to the only people qualified to read it.
 */
const STYLE = `/*
 * Generated by docs/site.ts. The palette is src/dashboard/styles.ts's.
 */

:root {
  color-scheme: light dark;

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

  --font: "Inter var", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI",
    "Helvetica Neue", Arial, sans-serif;
  --mono: "SF Mono", "JetBrains Mono", "Cascadia Mono", ui-monospace, Menlo, monospace;

  /*
   * One left rail, and prose capped at the measure inside it.
   *
   * The first version centred the reading column and the wide column
   * separately, which looks right until the viewport is wide enough that they
   * stop sharing an edge: at 1440 the logo sat ninety pixels left of the
   * headline under it. Two rails that agree at every width except the widest
   * are worse than one, because the disagreement only shows up on the screens
   * the page is most likely to be read on.
   */
  --measure: 38rem;
  --wide: 62rem;
  --gutter: 1.25rem;
  --rail: max(var(--gutter), 50% - var(--wide) / 2);
}

@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
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
  }
}

.col, .col--wide { padding-inline: var(--rail); }

/*
 * Prose stays at the measure; the table and the dashboard take the full rail.
 *
 * Every selector here is a *child* of the element carrying the rail padding,
 * deliberately. With border-box sizing, max-width includes padding, so an
 * element that is both the rail and the measure is 38rem of which the rail
 * eats all but a sliver -- which is exactly what the footer did until the
 * class moved up to the footer element and off the paragraph inside it.
 * (And the comment cannot use backticks: this whole stylesheet is a template
 * literal, so a backtick in it ends the string.)
 */
.lede > *, .review__intro > *, .install > *, .covers > *, .foot > p,
.evidence-section > p { max-width: var(--measure); }

.lede h1 { max-width: 18ch; }

*, *::before, *::after { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--canvas);
  color: var(--ink);
  font-family: var(--font);
  font-size: 1.0625rem;
  line-height: 1.62;
  -webkit-font-smoothing: antialiased;
}

a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }
a:hover { color: var(--ink); }

code, pre, .claim__figure strong, .evidence td, .evidence th {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

code { font-size: 0.9em; }

pre {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 8px;
  padding: 0.95rem 1.1rem;
  overflow-x: auto;
  font-size: 0.8125rem;
  line-height: 1.6;
  margin: 1.1rem 0;
}

pre code { font-size: inherit; }

/* -- masthead ------------------------------------------------------------ */

.masthead {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1.5rem;
  align-items: baseline;
  justify-content: space-between;
  padding-block: 1.4rem;
  border-bottom: 1px solid var(--rule);
}

.mark {
  font-weight: 650;
  letter-spacing: -0.01em;
  font-size: 1.0625rem;
  color: var(--ink);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
}

.mark__glyph {
  width: 0.95rem;
  height: 0.95rem;
  border-radius: 3px;
  background: var(--accent);
  flex: none;
}

.masthead__nav {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 1.25rem;
  font-size: 0.9375rem;
}

.masthead__nav a { color: var(--ink-secondary); text-decoration: none; }
.masthead__nav a:hover { color: var(--accent); text-decoration: underline; }

/* -- lede ---------------------------------------------------------------- */

.lede { padding-block: 4rem 2.5rem; }

h1 {
  margin: 0 0 1.1rem;
  font-size: clamp(2rem, 6.2vw, 3.1rem);
  line-height: 1.07;
  letter-spacing: -0.028em;
  font-weight: 650;
  text-wrap: balance;
}

.standfirst {
  margin: 0;
  font-size: 1.125rem;
  color: var(--ink-secondary);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1.25rem;
  align-items: center;
  margin: 1.9rem 0 0;
}

.cta {
  background: var(--accent);
  color: #fff;
  padding: 0.6rem 1.15rem;
  border-radius: 7px;
  font-size: 0.9375rem;
  font-weight: 550;
  text-decoration: none;
}

.cta:hover { filter: brightness(1.08); color: #fff; }

@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) .cta { color: #0d1117; }
  :root:where(:not([data-theme="light"])) .cta:hover { color: #0d1117; }
}

.plain { font-size: 0.9375rem; color: var(--ink-secondary); }

/* -- the claim ----------------------------------------------------------- */

.claim {
  background: var(--surface-sunken);
  border-block: 1px solid var(--rule);
  padding-block: 2.6rem;
}

.claim__figures {
  display: grid;
  gap: 1.6rem 2.5rem;
  grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
  margin-bottom: 1.8rem;
}

.claim__figure { margin: 0; display: flex; flex-direction: column; gap: 0.3rem; }

.claim__figure strong {
  font-size: clamp(1.75rem, 4.4vw, 2.4rem);
  line-height: 1;
  font-weight: 600;
  letter-spacing: -0.03em;
  color: var(--accent);
}

.claim__figure span {
  font-size: 0.875rem;
  color: var(--ink-secondary);
  line-height: 1.45;
}

.claim__detail {
  margin: 0;
  max-width: 40rem;
  font-size: 0.9375rem;
  color: var(--ink-secondary);
}

/* -- the dashboard ------------------------------------------------------- */

.review { padding-block: 3.4rem 1rem; }

.review__intro h2, .evidence-section h2, .install h2, .covers h2 {
  margin: 0 0 1rem;
  font-size: 1.5rem;
  letter-spacing: -0.018em;
  font-weight: 620;
}

.review__intro p, .evidence-section p, .install p, .covers p { margin: 0 0 1rem; }

.review__hint {
  font-size: 0.9375rem;
  color: var(--ink-secondary);
  border-left: 2px solid var(--good);
  padding-left: 0.9rem;
}

.review__frame {
  margin: 2rem 0 0;
  padding-inline: var(--rail);
}

.review__frame iframe {
  display: block;
  width: 100%;
  height: min(78vh, 920px);
  border: 1px solid var(--rule-strong);
  border-radius: 10px;
  background: var(--surface);
}

.review__fallback { margin: 0.9rem 0 0; font-size: 0.875rem; color: var(--ink-muted); }

/* -- evidence ------------------------------------------------------------ */

.evidence-section { padding-block: 3.4rem; }

.evidence {
  width: 100%;
  border-collapse: collapse;
  margin: 1.6rem 0;
  font-size: 0.8125rem;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 8px;
  overflow: hidden;
  display: table;
}

.evidence th, .evidence td {
  text-align: left;
  vertical-align: top;
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--rule);
  line-height: 1.5;
}

.evidence thead th {
  background: var(--surface-sunken);
  font-weight: 600;
  color: var(--ink-secondary);
  white-space: nowrap;
}

.evidence tbody tr:last-child td { border-bottom: 0; }
.evidence td:first-child { color: var(--ink-secondary); width: 42%; }
.evidence code { font-size: 1em; }

.aside {
  font-size: 0.9375rem;
  color: var(--ink-secondary);
  border-left: 2px solid var(--rule-strong);
  padding-left: 0.9rem;
}

.aside strong { color: var(--ink); font-weight: 600; }

/* -- install and covers -------------------------------------------------- */

.install { padding-block: 1rem 2rem; }
.covers { padding-block: 1rem 3.4rem; }

/* -- footer -------------------------------------------------------------- */

.foot {
  border-top: 1px solid var(--rule);
  padding-block: 1.9rem 2.6rem;
  font-size: 0.875rem;
  color: var(--ink-muted);
}

.foot p { margin: 0; }

/* Narrow screens: the table needs to scroll rather than squeeze. */
@media (max-width: 46rem) {
  .evidence { display: block; overflow-x: auto; }
  .evidence td:first-child { width: auto; min-width: 15rem; }
  .review__frame iframe { height: 70vh; }
  .masthead__nav { gap: 0.35rem 0.9rem; font-size: 0.875rem; }
}
`;

/**
 * Every file the site is made of, keyed by the name it is published under.
 *
 * Pure: it reads the engine and returns strings, so `tests/docs.test.ts` can
 * call it without a filesystem and the entry point beside it is the only thing
 * that writes anything.
 *
 * The dashboard is passed in rather than rendered here so that the page can
 * quote the artefact it is publishing — its size and its counts — instead of
 * describing it in the abstract. The caller writes the same object to disk, so
 * the figures on the page are figures about the file beside it.
 */
export function buildSite(dashboard: ReviewDashboard): Map<string, string> {
  // Measured once and passed to both: the accuracy sweep reconciles twenty
  // sets of books, and a page that cost twice what it needs to would get
  // built less often than it should.
  const measured = evidence();
  return new Map([
    ["index.html", landing(evidenceReport(measured), measured, counts(), dashboard)],
    ["style.css", STYLE],
  ]);
}
