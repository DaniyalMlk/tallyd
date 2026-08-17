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
- [x] **7 — Books at scale.** A seeded generator that builds a ledger and the
      bank statement to go with it at any size, carrying the ground truth of
      which line came from which posting. An accuracy report scored against it,
      a benchmark command, and a performance pass over the matcher: an
      amount-and-date index in front of the pair pass, maximum-weight matching
      solved per connected component, and group search bounded to one direction.
- [x] **8 — Matching memory.** Counterparty keys learnt from confirmed and
      refused decisions, persisted as plain JSON, and fed back into scoring as a
      rule that explains what it recalls. Rejections outweigh confirmations and
      veto the exact-match floor; a name only ever confirmed elsewhere counts
      against. `tallyd learn` folds a reviewer's decisions in.
- [x] **9 — Closing the loop.** The decisions document as a format both ends
      depend on, with the payload for each suggestion computed in TypeScript and
      the browser stamping only a verdict and a date. Export and undo in the
      review UI. Then the other direction: ordered classification rules from
      description and direction to an account, entry ids derived from the
      statement line's fingerprint so a re-import is a no-op, a `post` command
      that proposes or applies, and a dashboard section showing what the current
      state of the review implies, recomputed as decisions are made.

- [ ] **10 — Multi-currency.** Everything holds one currency at a time. A
      business that invoices in euros and banks in sterling has a revaluation
      problem the ledger can represent and nothing yet computes: rate sources,
      the gain or loss on settlement, and a translation of the statements.

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
| `src/demo/random.ts` | Seeded xorshift, so generated books are reproducible |
| `src/demo/generator.ts` | Books and the bank's version of them, at any size |
| `src/reconcile/candidates.ts` | Amount-and-date index: which pairs are worth scoring |
| `src/reconcile/accuracy.ts` | Precision and recall against the generator's truth |
| `src/reconcile/memory.ts` | Counterparty keys learnt from reviewed decisions |
| `src/reconcile/decisions.ts` | The decisions document, and what a match emits |
| `src/reconcile/posting.ts` | Classification rules and the entries a statement implies |

1150 tests across 46 files, typecheck clean.

## Known gaps

- CI is not wired up. The intended pipeline is `npm run typecheck`, `npm test`,
  and the four demos.
- The classification rules are a starting point and not a claim about anybody's
  business. They are written against the standard chart, in English, for a UK
  bank's descriptors; a different chart needs `--rules` and a different country
  needs most of them rewritten.
- A statement line the matcher merely failed to match looks exactly like a line
  the books are missing. `post` only proposes for lines with no suggestion at
  all, and a reviewer's rejection is applied directly rather than through the
  score — but `--suspense` will still book a missed match if one gets that far,
  and the command can only warn about it.
- Nothing learns from a classification. A reviewer who moves an entry from the
  suspense account to 5400 has stated a fact as useful as a confirmed match,
  and it goes nowhere: there is no equivalent of the counterparty memory for
  accounts.
- Proposed entries carry no VAT treatment. A gross bank charge is booked gross,
  which is right for that charge and wrong for most purchases.
- The dashboard embeds every posting in the file. At a year of a busy account
  that is a large page to open.
- The CLI reads a whole ledger into memory on every invocation. Fine for a
  year of a small company, wrong for anything larger.
- Ageing groups by reference alone, so an invoice and its credit note only
  net off when they share one. There is no counterparty dimension yet.
- Memory is keyed on the counterparty name and nothing else. Two suppliers whose
  names normalise to the same tokens share one entry, and a business that renames
  itself starts again from nothing.
- Memory never ages. A pairing confirmed once three years ago counts exactly as
  much as one confirmed last month, and `lastSeen` is recorded but not yet used
  to decay anything.
- Group matching is capped at four lines a side and, by design, never mixes
  directions, so a batch that is itself paid in two instalments is out of reach.
- The generator models one business shape — a small services company with
  invoices, a supplier run, card takings and payroll. It says nothing about
  books with foreign currency, intercompany transfers or a credit-card control
  account, so the benchmark numbers describe that shape and not every shape.
- The matcher still holds both sides in memory. A year of a busy account
  reconciles in about a fifth of a second, but books where hundreds of movements
  share one amount and one date collapse into a single graph component and get
  the dense solve, which is cubic. Nothing streams; nothing is incremental.
