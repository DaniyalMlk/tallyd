# Roadmap

A double-entry ledger and bank-reconciliation engine. The interesting part is not
storing transactions — it is the matching engine that decides which bank statement
lines correspond to which ledger entries when the amounts, dates, and descriptions
all disagree slightly.

## Design constraints

- Money is integer minor units. No floats anywhere in the accounting path.
- Every posting balances or it is rejected. The invariant is enforced at the type
  boundary, not by a validation pass afterwards.
- The reconciliation engine must explain itself: every match carries a score and
  the reasons behind it, so a human reviewing the queue can see why.
- No paid APIs. Demo data is generated deterministically.

## Phases

- [x] **1 — Money and the chart of accounts.** `Money` with currency-safe
      arithmetic, rounding, and allocation (splitting 100 into 3 without losing a
      cent). Account tree, normal balances, account types.
- [x] **2 — Posting engine.** Journal entries, the balancing invariant, an
      immutable append-only ledger, running balances, trial balance.
- [x] **3 — Statement ingestion.** CSV and OFX-lite parsers, column inference,
      date-format detection, currency normalisation, duplicate detection on import.
- [x] **4 — Reconciliation matching.** Exact match, amount-and-date window match,
      fuzzy description scoring, one-to-many splits and many-to-one aggregations.
      Confidence scoring with per-rule explanations, optimal conflict resolution,
      and a bank reconciliation statement that bridges bank to ledger.
- [x] **5 — Reports and CLI.** Trial balance, P&L, balance sheet, ageing. A CLI
      that ingests a statement, reconciles it, and prints the review queue,
      with a JSON ledger document format underneath it.
- [x] **6 — Dashboard.** Ledger explorer and reconciliation review UI, with charts
      for cash position and match-confidence distribution. One self-contained
      HTML file: no CDN, no bundler, opens offline.
- [ ] **7 — Polish.** Demo dataset generator, CI, performance pass over the matcher.

## Current state

| Module | What it does |
|---|---|
| `src/money/rounding.ts` | Seven rounding modes over exact bigint division |
| `src/money/currency.ts` | ISO currency registry with minor-unit exponents |
| `src/money/money.ts` | `Money`: exact arithmetic, `split`, `allocate`, formatting |
| `src/accounts/types.ts` | Five account types, normal balances, statement classes |
| `src/accounts/chart.ts` | Immutable validated account tree |
| `src/accounts/standard.ts` | A small-business chart in 1000-blocks |
| `src/ledger/date.ts` | Timezone-free calendar dates and day arithmetic |
| `src/ledger/entry.ts` | `JournalEntry` — unbalanced entries cannot be constructed |
| `src/ledger/ledger.ts` | Append-only ledger, balance index, `verify()` |
| `src/ledger/trialBalance.ts` | Trial balance, per-type totals, equation residual |
| `src/statement/csv.ts` | RFC 4180 reader, delimiter sniffing, preamble skip |
| `src/statement/amount.ts` | Amount parsing across bank formats and locales |
| `src/statement/dates.ts` | Column-wide date format detection |
| `src/statement/columns.ts` | Column-role inference for unknown statement layouts |
| `src/statement/ofx.ts` | OFX-lite reader |
| `src/statement/duplicates.ts` | Duplicate detection on import |
| `src/statement/import.ts` | Import pipeline tying the readers together |
| `src/reconcile/bankView.ts` | The ledger projected into bank-direction movements |
| `src/reconcile/similarity.ts` | Levenshtein, Jaro-Winkler, weighted token overlap, references |
| `src/reconcile/subsetSum.ts` | Bounded subset-sum search for grouped matches |
| `src/reconcile/assignment.ts` | Maximum-weight bipartite matching (Hungarian) |
| `src/reconcile/scoring.ts` | Gates, weighted rules and per-rule explanations |
| `src/reconcile/matcher.ts` | Group pass, optimal pair pass, review queue |
| `src/reconcile/bridge.ts` | Bank reconciliation statement |
| `src/demo/month.ts` | A worked month for a small consultancy |
| `src/demo/statement.ts` | The bank's view of that same month |
| `src/demo/supplierRun.ts` | A batch payment and a lump-sum receipt |
| `src/demo/reconcile.ts` | The two matched against each other |
| `src/ledger/serialise.ts` | JSON document format, validated on load |
| `src/reports/period.ts` | Movements over a range, balances as at a date |
| `src/reports/incomeStatement.ts` | P&L with a comparative period |
| `src/reports/balanceSheet.ts` | Balance sheet, period result folded into equity |
| `src/reports/ageing.ts` | Open items and ageing buckets |
| `src/cli/args.ts` | Argument parsing, written rather than installed |
| `src/cli/run.ts` | The five commands, as a pure function |
| `src/demo/receivables.ts` | A quarter of sales with a real ageing profile |
| `src/demo/statements.ts` | All four statements over that quarter |
| `src/dashboard/model.ts` | The reconciliation flattened for the browser |
| `src/dashboard/charts.ts` | Cash position and confidence, as hand-drawn SVG |
| `src/dashboard/styles.ts` | The stylesheet, inlined |
| `src/dashboard/script.ts` | Accept/reject, live bridge, ledger drill-down |
| `src/dashboard/render.ts` | Page assembly and escaping |

789 tests across 31 files, typecheck clean.

## Known gaps

- CI is not wired up. The intended pipeline is `npm run typecheck`, `npm test`,
  and the four demos.
- Decisions made in the dashboard are not written back. Accepting a match
  changes the page and nothing else; there is no way yet to emit the journal
  entries a reviewed reconciliation implies.
- The dashboard embeds every posting in the file. At a year of a busy account
  that is a large page to open.
- The CLI reads a whole ledger into memory on every invocation. Fine for a
  year of a small company, wrong for anything larger.
- Ageing groups by reference alone, so an invoice and its credit note only
  net off when they share one. There is no counterparty dimension yet.
- Matching has no memory. A pair a reviewer confirms today teaches it nothing
  about the same counterparty next month, and it should — a confirmed match is
  the cheapest training signal available.
- Group matching is capped at four lines a side and never mixes directions, so a
  batch that is itself paid in two instalments is out of reach.
- The matcher holds both sides in memory and scores every surviving pair. Fine
  for a month; the performance pass in phase 7 is where a year gets addressed.
