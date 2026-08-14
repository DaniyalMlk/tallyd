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
- [ ] **4 — Reconciliation matching.** Exact match, amount-and-date window match,
      fuzzy description scoring, one-to-many splits and many-to-one aggregations.
      Confidence scoring with per-rule explanations.
- [ ] **5 — Reports and CLI.** Trial balance, P&L, balance sheet, ageing. A CLI
      that ingests a statement, reconciles it, and prints the review queue.
- [ ] **6 — Dashboard.** Ledger explorer and reconciliation review UI, with charts
      for cash position and match-confidence distribution.
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
| `src/demo/month.ts` | A worked month for a small consultancy |
| `src/demo/statement.ts` | The bank's view of that same month |

478 tests across 16 files, typecheck clean.

## Known gaps

- CI is not wired up. The intended pipeline is `npm run typecheck`, `npm test`,
  `npm run demo`, `npm run demo:ingest`.
- Phase 4 needs the matcher itself: the ingestion side produces normalised
  statement lines, but nothing yet pairs them against ledger entries.
