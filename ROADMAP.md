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
- A consolidation must explain itself the same way: every adjustment is a
  balanced journal entry with a narration, never a figure applied to a total.
- Ownership is an exact fraction. It gets multiplied down chains and then
  multiplied by money, and a rounded percentage becomes pence nobody can trace.
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

- [x] **10 — Multi-currency.** A rate as an exact rational over bigints, and a
      dated table that answers a pair directly, by inversion, or through the
      shortest path of quoted currencies — on-or-before, with a staleness
      bound, carrying its own provenance. A posting that records both what
      moved and what it was booked at, with the balancing invariant staying in
      the functional currency where it belongs. Retranslation at the close,
      idempotent by construction and working per open item so that settling one
      invoice out of several measures against what it is now carried at rather
      than what it was booked at. Realised gain and loss on settlement, from a
      rate, a table, or what the bank actually credited. And translation into a
      presentation currency: closing rate for the balance sheet, average for the
      P&L, historical for equity, and the residual named as a translation
      adjustment rather than plugged into retained earnings.

- [x] **11 — Consolidation.** An ownership interest as an exact fraction over
      bigints, and a holding graph rather than a tree, so a company held from
      two places comes out at the sum over both paths. Control and ownership
      settled separately: a company held 80% of a company held 75% consolidates
      in full and carries a 40% interest belonging to shareholders outside the
      group. Every controlled entity's books translated and added in full, each
      entity's translation adjustment kept apart from the others. Intercompany
      balances declared from both ends and paired on the relationship, with the
      residual — cash in transit, goods in transit, rates that do not
      reciprocate — carried in a named account rather than plugged, and a
      one-sided declaration reported instead of eliminated. Goodwill from the
      consideration, the non-controlling interest at acquisition measured
      proportionately or at fair value, and a bargain purchase as a gain rather
      than a negative asset. The whole thing assembled into a ledger in the
      presentation currency, one balanced entry per step, that every existing
      report reads and that serialises and loads back.

- [ ] **12 — Consolidating over time.** A consolidation is prepared every period
      and each one currently starts from nothing. The comparatives, the movement
      in the non-controlling interest and in the translation reserve, and a
      group that acquires or disposes of a company part-way through a year are
      all questions about two dates rather than one, and none of them can be
      answered by a report that only knows about the reporting date.

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
| `src/fx/rate.ts` | An exchange rate as an exact rational over bigints |
| `src/fx/table.ts` | Dated quotes; on-or-before lookup, inversion, triangulation |
| `src/fx/average.ts` | Period averages, quoted and per-calendar-day |
| `src/fx/document.ts` | The rate document, and the wide CSV a provider publishes |
| `src/fx/exposure.ts` | Foreign balances, per account and per open item |
| `src/fx/revaluation.ts` | Retranslation at a closing rate, idempotent by construction |
| `src/fx/settlement.ts` | Realised gain and loss, measured against what is carried |
| `src/demo/foreign.ts` | A quarter with a euro customer and a dollar supplier |
| `src/demo/foreignReport.ts` | That quarter closed, settled, and the arithmetic checked |
| `src/fx/translate.ts` | The statements restated in a presentation currency |
| `src/group/interest.ts` | An ownership interest as an exact fraction over bigints |
| `src/group/structure.ts` | The holding graph: effective interest, control, what is left out |
| `src/group/accounts.ts` | The accounts that exist only when there is more than one company |
| `src/group/aggregate.ts` | Every controlled entity translated and added, in full |
| `src/group/intercompany.ts` | Declared balances paired, eliminated, and the residual named |
| `src/group/acquisition.ts` | Goodwill, the outside stake, and a bargain purchase |
| `src/group/consolidate.ts` | The consolidation, assembled into a ledger |
| `src/group/document.ts` | The group document, validated on the way in |
| `src/demo/group.ts` | Three companies in three currencies, one held through another |
| `src/demo/groupReport.ts` | That group consolidated, with the split checked at the end |

1611 tests across 66 files, typecheck clean.

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
- The dashboard knows nothing about foreign currency. It reconciles one bank
  account in one currency, which is right for what it does, but there is no
  view of what is exposed and no way to work through a revaluation in it.
- Translation restates the trial balance. The income statement and balance
  sheet renderers still read the functional-currency figures, so `--present`
  prints a translated trial balance beside them rather than a translated set
  of statements.
- The translation adjustment is computed and shown but never posted. There is
  no reserve account for it and no entry, so a translated balance sheet cannot
  be loaded back in as a ledger.
- A statement in a foreign currency cannot be reconciled. The matcher compares
  amounts in one currency, so a euro bank account needs its own reconciliation
  against a euro statement — which works, but nothing bridges the two.
- The revaluation reads the whole ledger to find its open items, once per run.
  Fine at a year of a small company, wrong for anything that has to close in
  seconds.
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
- Unrealised profit on goods one group company has sold to another and which
  are still in stock is not eliminated. The trading is taken out and the margin
  sitting inside the buyer's inventory is not, so consolidated stock is carried
  at what the group charged itself rather than at what it cost.
- An associate is identified and then left alone. It is neither consolidated nor
  equity accounted, so a 30% holding shows in the group's books at whatever the
  investment cost and nothing of its results reaches the consolidated income
  statement.
- Goodwill is measured once and never impaired, and it is carried at the
  acquisition-date rate rather than retranslated at the closing rate as goodwill
  arising on a foreign operation should be.
- Fair value adjustments on acquisition can only be given as a single figure for
  the net assets acquired. There is no way to say which asset was written up, so
  nothing depreciates the uplift afterwards.
- Indirect holdings use the direct method: goodwill on a company held through a
  subsidiary is measured against what the subsidiary paid, in full. The
  alternative treatment, which scales that cost by the group's interest in the
  buyer, is not available.
- The income and expense balances in an entity's trial balance are taken to be
  the reporting period's result, which is true of books closed to retained
  earnings each year end and false of books that have never been closed.
- One consolidation, one date. There are no comparatives, no movement schedule
  for the non-controlling interest or the translation reserve, and no way to
  express a company acquired or sold part-way through the period.
- The dashboard knows nothing about groups. It reconciles one bank account for
  one company, which is what it is for, but there is no view of a consolidation.
- The matcher still holds both sides in memory. A year of a busy account
  reconciles in about a fifth of a second, but books where hundreds of movements
  share one amount and one date collapse into a single graph component and get
  the dense solve, which is cubic. Nothing streams; nothing is incremental.
